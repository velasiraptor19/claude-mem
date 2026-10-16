import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { parseCodexTranscript } from '../../src/services/recovery/CodexTranscriptRecovery.js';
import { HistoricalFingerprintReconciler } from '../../src/services/recovery/HistoricalFingerprintReconciler.js';
import { HistoricalRecoveryScanner } from '../../src/services/recovery/HistoricalRecoveryScanner.js';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

function makeTranscript(session = 'root-session') {
  root ||= mkdtempSync(join(tmpdir(), 'cmem-reconcile-'));
  const path = join(root, `${session}.jsonl`);
  writeFileSync(path, [
    { type: 'session_meta', payload: { id: session, session_id: session, cwd: '/work/project' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'first request' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'first result' } },
  ].map(JSON.stringify).join('\n'));
  return parseCodexTranscript(path);
}

function addSummary(store: SessionStore, contentId: string, promptNumber: number | null, project = 'project'): number {
  const memoryId = `memory:${contentId}`;
  store.db.prepare(`INSERT INTO sdk_sessions
    (content_session_id,memory_session_id,project,platform_source,user_prompt,started_at,started_at_epoch,status)
    VALUES (?,?,?,?,?,?,?,'completed')`).run(contentId, memoryId, project, 'codex', '', new Date(0).toISOString(), 0);
  return (store.db.prepare(`INSERT INTO session_summaries
    (memory_session_id,project,request,investigated,learned,completed,next_steps,prompt_number,discovery_tokens,created_at,created_at_epoch)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
      memoryId, project, 'request', '', '', 'done', '', promptNumber, 0, new Date(0).toISOString(), 0,
    ) as { id: number }).id;
}

describe('historical fingerprint reconciliation', () => {
  it('stamps an exact original summary and is idempotent', () => {
    const store = new SessionStore(':memory:');
    const transcript = makeTranscript();
    addSummary(store, 'root-session', 1);
    const reconciler = new HistoricalFingerprintReconciler(store);
    const dry = reconciler.reconcile([transcript], true);
    expect(dry).toEqual(expect.objectContaining({ represented: 1, summaryFingerprintsWritten: 0, representationRowsWritten: 0 }));
    expect((store.db.prepare('SELECT COUNT(*) n FROM historical_summary_representations').get() as { n: number }).n).toBe(0);
    const first = reconciler.reconcile([transcript], false);
    const second = reconciler.reconcile([transcript], false);
    expect(first).toEqual(expect.objectContaining({ represented: 1, summaryFingerprintsWritten: 1, representationRowsWritten: 1 }));
    expect(second).toEqual(expect.objectContaining({ represented: 1, summaryFingerprintsWritten: 0, representationRowsWritten: 0 }));
  });

  it('prefers a provable merged backfill and suppresses scanner replay', async () => {
    const store = new SessionStore(':memory:');
    const transcript = makeTranscript();
    addSummary(store, 'codex-backfill:root-session:p1:part-1', 1);
    addSummary(store, 'codex-backfill:root-session:p1:part-2', 1);
    const mergedId = addSummary(store, 'codex-backfill:root-session:p1:merged-v2', 1);
    const result = new HistoricalFingerprintReconciler(store).reconcile([transcript], false);
    expect(result).toEqual(expect.objectContaining({ represented: 1, summaryFingerprintsWritten: 1 }));
    expect((store.db.prepare('SELECT source_fingerprint FROM session_summaries WHERE id=?').get(mergedId) as { source_fingerprint: string }).source_fingerprint).toBe(transcript.turns[0].sourceFingerprint);
    const scan = await new HistoricalRecoveryScanner(store, undefined, root).scan(true);
    expect(scan).toEqual(expect.objectContaining({ enqueued: 0, alreadyRepresented: 1 }));
  });

  it('accepts one exact part but leaves multi-part-without-merge ambiguous', () => {
    const one = new SessionStore(':memory:');
    const transcript = makeTranscript();
    addSummary(one, 'codex-backfill:root-session:p1:part-1', 1);
    expect(new HistoricalFingerprintReconciler(one).reconcile([transcript], false)).toEqual(expect.objectContaining({ represented: 1, summaryFingerprintsWritten: 1 }));

    const many = new SessionStore(':memory:');
    addSummary(many, 'codex-backfill:root-session:p1:part-1', 1);
    addSummary(many, 'codex-backfill:root-session:p1:part-2', 1);
    const result = new HistoricalFingerprintReconciler(many).reconcile([transcript], false);
    expect(result.represented).toBe(0);
    expect(result.ambiguous[0]?.reason).toBe('parts_without_provable_merged_summary');
  });

  it('does not stamp ambiguous original summaries', () => {
    const store = new SessionStore(':memory:');
    const transcript = makeTranscript();
    addSummary(store, 'root-session', 1);
    store.db.prepare(`INSERT INTO session_summaries
      (memory_session_id,project,request,investigated,learned,completed,next_steps,prompt_number,discovery_tokens,created_at,created_at_epoch)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('memory:root-session', 'project', 'second', '', '', '', '', 1, 0, new Date(1).toISOString(), 1);
    const result = new HistoricalFingerprintReconciler(store).reconcile([transcript], false);
    expect(result.represented).toBe(0);
    expect(result.ambiguous[0]?.reason).toBe('multiple_original_summaries');
    expect((store.db.prepare('SELECT COUNT(*) n FROM session_summaries WHERE source_fingerprint IS NOT NULL').get() as { n: number }).n).toBe(0);
  });

  it('is idempotent on a bounded temporary on-disk corpus', () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-reconcile-corpus-'));
    const copy = join(root, 'corpus.db');
    const store = new SessionStore(copy);
    const transcripts = Array.from({ length: 64 }, (_, index) => {
      const transcript = makeTranscript(`corpus-session-${index}`);
      addSummary(store, transcript.lineage.contentSessionId, 1);
      return transcript;
    });
    const reconciler = new HistoricalFingerprintReconciler(store);
    const dry = reconciler.reconcile(transcripts, true);
    const applied = reconciler.reconcile(transcripts, false);
    const rerun = reconciler.reconcile(transcripts, false);
    expect(applied.canonicalTurns).toBe(dry.canonicalTurns);
    expect(applied.represented).toBe(dry.represented);
    expect(rerun.summaryFingerprintsWritten).toBe(0);
    expect(rerun.representationRowsWritten).toBe(0);
    expect((store.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});
