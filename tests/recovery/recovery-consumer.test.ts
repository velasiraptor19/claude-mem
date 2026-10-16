import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { RecoveryJobService } from '../../src/services/recovery/RecoveryJobService.js';
import { RecoveryConsumer } from '../../src/services/recovery/RecoveryConsumer.js';
import { parseCodexTranscript, recoveryKeyFor } from '../../src/services/recovery/CodexTranscriptRecovery.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
function fixture(): { store: SessionStore; locator: string; enqueue: () => number } {
  dir = mkdtempSync(join(tmpdir(), 'cmem-consumer-'));
  const locator = join(dir, 'root.jsonl');
  writeFileSync(locator, [
    { type: 'session_meta', payload: { id: 'root', session_id: 'root', cwd: '/work/project' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'fix it' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'fixed with tests' } },
  ].map(JSON.stringify).join('\n'));
  const store = new SessionStore(':memory:');
  const parsed = parseCodexTranscript(locator); const turn = parsed.turns[0];
  return { store, locator, enqueue: () => new RecoveryJobService(store).enqueue({
    contentSessionId: 'root', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex',
    transcriptLocator: locator, reason: 'test', recoveryKey: recoveryKeyFor(parsed, turn),
    sourceFingerprint: turn.sourceFingerprint, promptNumber: turn.promptNumber, turnId: turn.turnId,
    rootContentSessionId: 'root', transcriptSha256: parsed.transcriptSha256,
  }).id };
}
const dbManager = (store: SessionStore, chroma: any = null) => ({ getSessionStore: () => store, getChromaSync: () => chroma }) as any;
const summary = { request: 'fix it', investigated: 'code', learned: 'cause', completed: 'fixed', next_steps: '', notes: null, model: 'nim' };

describe('RecoveryConsumer error policy', () => {
  it('stores and completes a valid canonical recovery exactly once', async () => {
    const f = fixture(); const id = f.enqueue(); let calls = 0;
    const consumer = new RecoveryConsumer(dbManager(f.store), { generateRecoverySummary: async () => { calls++; return summary; } } as any);
    await consumer.tick(true); await consumer.tick(true);
    expect(f.store.getRecoveryJob(id)?.status).toBe('completed'); expect(calls).toBe(1);
    expect((f.store.db.prepare('SELECT COUNT(*) n FROM session_summaries').get() as any).n).toBe(1);
  });
  it('anchors malformed batches to canonical turns accepted by the real consumer', async () => {
    const f = fixture();
    const service = new RecoveryJobService(f.store);
    const [job] = await service.enqueueMalformedBatch({ content_session_id: 'root', platform_source: 'codex', transcript_locator: f.locator, project: 'project' }, [{ prompt_number: 1 }], 'malformed_xml');
    const consumer = new RecoveryConsumer(dbManager(f.store), { generateRecoverySummary: async () => summary } as any);
    await consumer.tick(true);
    expect(f.store.getRecoveryJob(job.id)?.status).toBe('completed');
    expect(job.source_fingerprint).toBeTruthy();
    expect(job.root_content_session_id).toBe('root');
  });

  it('rejects unsupported or incomplete malformed batches without creating recovery jobs', async () => {
    const f = fixture();
    const service = new RecoveryJobService(f.store);
    const row = { content_session_id: 'root', platform_source: 'codex', transcript_locator: f.locator, project: 'project' };
    await expect(service.enqueueMalformedBatch({ ...row, platform_source: 'claude-code' }, [{ prompt_number: 1 }], 'malformed')).rejects.toThrow('Canonical Codex');
    await expect(service.enqueueMalformedBatch(row, [{ prompt_number: 1 }, { prompt_number: 2 }], 'malformed')).rejects.toThrow('missing or ambiguous');
    await expect(service.enqueueMalformedBatch(row, [{}], 'malformed')).rejects.toThrow('prompt required');
    expect((f.store.db.prepare('SELECT COUNT(*) n FROM recovery_jobs').get() as any).n).toBe(0);
  });

  it('parks auth failures without a hot loop', async () => {
    const f = fixture(); const id = f.enqueue();
    const consumer = new RecoveryConsumer(dbManager(f.store), { generateRecoverySummary: async () => { throw new ClassifiedProviderError('bad key', { kind: 'auth_invalid', cause: null }); } } as any);
    await consumer.tick(true); const job = f.store.getRecoveryJob(id)!;
    expect(job.status).toBe('retry_wait'); expect(job.last_sanitized_error).toContain('blocked_auth'); expect(job.next_attempt_at_epoch).toBeGreaterThan(Date.now() + 14 * 60_000);
  });
  it('honors quota Retry-After and retries 5xx/transient failures', async () => {
    const f = fixture(); const id = f.enqueue(); const before = Date.now();
    const quota = new RecoveryConsumer(dbManager(f.store), { generateRecoverySummary: async () => { throw new ClassifiedProviderError('rate', { kind: 'rate_limit', cause: null, retryAfterMs: 45_000 }); } } as any);
    await quota.tick(true); expect(f.store.getRecoveryJob(id)?.next_attempt_at_epoch).toBeGreaterThanOrEqual(before + 45_000);
    f.store.db.prepare("UPDATE recovery_jobs SET status='pending', next_attempt_at_epoch=0 WHERE id=?").run(id);
    const transient = new RecoveryConsumer(dbManager(f.store), { generateRecoverySummary: async () => { throw new ClassifiedProviderError('upstream', { kind: 'transient', cause: null }); } } as any);
    await transient.tick(true); expect(f.store.getRecoveryJob(id)?.status).toBe('retry_wait');
  });
  it('parks quota exhaustion for a safe window, then requires manual resume without losing the job', async () => {
    const f = fixture(); const id = f.enqueue(); let calls = 0; const before = Date.now();
    const consumer = new RecoveryConsumer(dbManager(f.store), { generateRecoverySummary: async () => {
      calls++; throw new ClassifiedProviderError('credits exhausted', { kind: 'quota_exhausted', cause: null });
    } } as any);
    await consumer.tick(true);
    const parked = f.store.getRecoveryJob(id)!;
    expect(parked.status).toBe('retry_wait');
    expect(parked.next_attempt_at_epoch).toBeGreaterThanOrEqual(before + 24 * 60 * 60_000);
    expect(parked.last_sanitized_error).toContain('blocked_quota_exhausted');
    await consumer.tick(true);
    expect(calls).toBe(1);
    expect(f.store.getRecoveryJob(id)?.transcript_locator).toBe(f.locator);
    f.store.db.prepare('UPDATE recovery_jobs SET next_attempt_at_epoch=0 WHERE id=?').run(id);
    await consumer.tick(true);
    expect(f.store.getRecoveryJob(id)).toEqual(expect.objectContaining({ status: 'dead_letter', dead_letter_reason: expect.stringContaining('blocked_quota_exhausted_manual_resume') }));
    expect(calls).toBe(2);
    expect(new RecoveryJobService(f.store).resumeDeadLetter(id)).toBe(true);
    expect(f.store.getRecoveryJob(id)).toEqual(expect.objectContaining({ status: 'pending', transcript_locator: f.locator }));
  });
  it('does not mark completed when Chroma sync fails, and retries indexing without regenerating', async () => {
    const f = fixture(); const id = f.enqueue(); let generation = 0; let chromaCalls = 0;
    const chroma = { syncSummary: async () => { chromaCalls++; if (chromaCalls === 1) throw new Error('chroma down'); return { expected: 3, written: 3, complete: true }; } };
    const provider = { generateRecoverySummary: async () => { generation++; return summary; } } as any;
    const first = new RecoveryConsumer(dbManager(f.store, chroma), provider); await first.tick(true);
    expect(f.store.getRecoveryJob(id)?.status).toBe('retry_wait');
    f.store.db.prepare('UPDATE recovery_jobs SET next_attempt_at_epoch=0 WHERE id=?').run(id);
    const second = new RecoveryConsumer(dbManager(f.store, chroma), provider); await second.tick(true);
    expect(f.store.getRecoveryJob(id)?.status).toBe('completed'); expect(generation).toBe(1); expect(chromaCalls).toBe(2);
  });
  it('keeps a staged SQLite summary retryable after a silent partial Chroma write', async () => {
    const f = fixture(); const id = f.enqueue(); let generation = 0;
    const chroma = { syncSummary: async () => ({ expected: 3, written: 2, complete: false }) };
    const consumer = new RecoveryConsumer(dbManager(f.store, chroma), { generateRecoverySummary: async () => { generation++; return summary; } } as any);
    await consumer.tick(true);
    expect(f.store.getRecoveryJob(id)?.status).toBe('retry_wait');
    expect(generation).toBe(1);
    expect((f.store.db.prepare('SELECT COUNT(*) n FROM session_summaries').get() as any).n).toBe(1);
  });
  it('accepts append-only transcript growth when the exact queued turn is unchanged', async () => {
    const f = fixture(); const id = f.enqueue(); let calls = 0;
    writeFileSync(f.locator, `${readFileSync(f.locator, 'utf8')}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'more work' } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2', last_agent_message: 'more done' } })}`);
    await new RecoveryConsumer(dbManager(f.store), { generateRecoverySummary: async () => { calls++; return summary; } } as any).tick(true);
    expect(f.store.getRecoveryJob(id)?.status).toBe('completed');
    expect(calls).toBe(1);
  });
  it('dead-letters lineage mismatches before calling NVIDIA or writing a summary', async () => {
    const f = fixture(); const id = f.enqueue(); let calls = 0;
    f.store.db.prepare("UPDATE recovery_jobs SET parent_content_session_id='wrong-parent' WHERE id=?").run(id);
    await new RecoveryConsumer(dbManager(f.store), { generateRecoverySummary: async () => { calls++; return summary; } } as any).tick(true);
    expect(calls).toBe(0);
    expect(f.store.getRecoveryJob(id)).toEqual(expect.objectContaining({ status: 'dead_letter', dead_letter_reason: 'lineage_mismatch: job and canonical transcript differ' }));
    expect((f.store.db.prepare('SELECT COUNT(*) n FROM session_summaries').get() as { n: number }).n).toBe(0);
  });
});
