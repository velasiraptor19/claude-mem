import { afterEach, describe, expect, it } from 'bun:test';
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { parseCodexTranscript, recoveryKeyFor, sha256Text } from '../../src/services/recovery/CodexTranscriptRecovery.js';
import { HistoricalRecoveryScanner } from '../../src/services/recovery/HistoricalRecoveryScanner.js';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });
const line = (value: unknown) => JSON.stringify(value);
function transcript(name: string, meta: Record<string, unknown>, evidence: 'assistant' | 'tool' | 'none' = 'assistant'): string {
  const path = join(root, `${name}.jsonl`);
  const rows: unknown[] = [
    { type: 'session_meta', payload: meta, timestamp: '2026-07-01T10:00:00Z' },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: `${name}-turn` }, timestamp: '2026-07-01T10:00:30Z' },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `request ${name}` }] }, timestamp: '2026-07-01T10:01:00Z' },
    { type: 'event_msg', payload: { type: 'user_message', message: `request ${name}` }, timestamp: '2026-07-01T10:01:00Z' },
  ];
  if (evidence === 'assistant') rows.push(
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `completed ${name}` }] }, timestamp: '2026-07-01T10:01:30Z' },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: `${name}-turn`, last_agent_message: `completed ${name}` }, timestamp: '2026-07-01T10:02:00Z' },
  );
  if (evidence === 'tool') rows.push(
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: `${name}-call`, arguments: '{}' }, timestamp: '2026-07-01T10:01:30Z' },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: `${name}-call`, output: `verified output ${name}` }, timestamp: '2026-07-01T10:02:00Z' },
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: `${name}-turn`, reason: 'interrupted' }, timestamp: '2026-07-01T10:02:30Z' },
  );
  writeFileSync(path, rows.map(line).join('\n'));
  return path;
}

describe('Codex canonical transcript recovery', () => {
  it('extracts deterministic depth-1/depth-2 lineage and evidence without inventing a prompt', () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const child = transcript('child', { id: 'child', session_id: 'root', parent_thread_id: 'root', cwd: '/work/project', source: { subagent: { thread_spawn: { parent_thread_id: 'root', depth: 1, agent_path: 'explorer', agent_nickname: 'Ada' } } } });
    const grandchild = transcript('grandchild', { id: 'grandchild', session_id: 'root', parent_thread_id: 'child', cwd: '/work/project', source: { subagent: { thread_spawn: { parent_thread_id: 'child', depth: 2, agent_path: 'tester', agent_nickname: 'Turing' } } } }, 'tool');
    const one = parseCodexTranscript(child); const two = parseCodexTranscript(grandchild);
    expect(one.lineage).toEqual(expect.objectContaining({ contentSessionId: 'child', parentContentSessionId: 'root', rootContentSessionId: 'root', agentDepth: 1, agentNickname: 'Ada' }));
    expect(two.lineage).toEqual(expect.objectContaining({ parentContentSessionId: 'child', agentDepth: 2 }));
    expect(two.turns[0].userMessage).toBe('request grandchild');
    expect(two.turns[0].finalAssistantMessage).toBeNull();
    expect(two.turns[0].completionState).toBe('aborted');
    expect(two.turns[0].toolEvidence[0]).toEqual(expect.objectContaining({ callId: 'grandchild-call', source: 'exec_command', content: 'verified output grandchild' }));
  });

  it('excludes the parent replay snapshot from Codex 0.146 forked subagent transcripts', () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const path = join(root, 'forked-child.jsonl');
    writeFileSync(path, [
      { type: 'session_meta', timestamp: '2026-08-03T07:33:56.480Z', payload: { id: 'child', session_id: 'root', parent_thread_id: 'root', timestamp: '2026-08-03T07:33:56.329Z', cwd: '/work/project', source: { subagent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } } } },
      { type: 'session_meta', timestamp: '2026-08-03T07:33:56.480Z', payload: { id: 'root', session_id: 'root', timestamp: '2026-07-10T15:12:05.713Z', cwd: '/work/project', source: 'cli' } },
      { type: 'event_msg', timestamp: '2026-08-03T07:33:56.481Z', payload: { type: 'task_started', turn_id: 'parent-turn', started_at: 1783696458 } },
      { type: 'event_msg', timestamp: '2026-08-03T07:33:56.481Z', payload: { type: 'user_message', message: 'parent request' } },
      { type: 'event_msg', timestamp: '2026-08-03T07:33:56.481Z', payload: { type: 'task_complete', turn_id: 'parent-turn', last_agent_message: 'parent result' } },
      { type: 'event_msg', timestamp: '2026-08-03T07:33:56.661Z', payload: { type: 'task_started', turn_id: 'child-turn', started_at: 1785742436 } },
      { type: 'event_msg', timestamp: '2026-08-03T07:33:59.056Z', payload: { type: 'user_message', message: 'child assignment' } },
      { type: 'event_msg', timestamp: '2026-08-03T07:35:31.007Z', payload: { type: 'task_complete', turn_id: 'child-turn', last_agent_message: 'child report' } },
    ].map(line).join('\n'));
    const parsed = parseCodexTranscript(path);
    expect(parsed.lineage).toEqual(expect.objectContaining({ contentSessionId: 'child', parentContentSessionId: 'root', agentType: 'subagent' }));
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]).toEqual(expect.objectContaining({ promptNumber: 1, turnId: 'child-turn', userMessage: 'child assignment', finalAssistantMessage: 'child report' }));
  });

  it('rejects unpaired tool output and assistant prose from an aborted turn', () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const path = join(root, 'aborted.jsonl');
    writeFileSync(path, [
      { type: 'session_meta', payload: { id: 'aborted', session_id: 'aborted', cwd: '/work/project', source: 'cli' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'do risky work' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'maybe done' }] } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'unknown', output: 'untrusted orphan output' } },
      { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-a', reason: 'interrupted' } },
    ].map(line).join('\n'));
    expect(parseCodexTranscript(path).turns).toHaveLength(0);
  });

  it('uses task_started IDs with response-user fallback and preserves paired EOF evidence as incomplete', () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const path = join(root, 'legacy-subagent.jsonl');
    writeFileSync(path, [
      { type: 'session_meta', payload: { id: 'legacy-child', session_id: 'root', parent_thread_id: 'root', cwd: '/work/project', source: { subagent: { thread_spawn: { parent_thread_id: 'root', depth: 1, agent_path: 'worker', agent_nickname: 'Lin' } } } } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'stable-turn-id' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'legacy request' }] } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch-1', input: '{}' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'patch-1', output: 'patch applied' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'stable-turn-id', last_agent_message: 'legacy complete' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'incomplete-turn-id' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect more' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'inspect more' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'exec-1', arguments: '{}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'exec-1', output: 'verified state' } },
    ].map(line).join('\n'));
    const parsed = parseCodexTranscript(path);
    expect(parsed.turns.map(turn => [turn.turnId, turn.completionState])).toEqual([
      ['stable-turn-id', 'completed'],
      ['incomplete-turn-id', 'incomplete'],
    ]);
    expect(parsed.turns[0].userMessage).toBe('legacy request');
    expect(parsed.turns[0].toolEvidence[0]).toEqual(expect.objectContaining({ source: 'apply_patch', callId: 'patch-1' }));
    expect(parsed.turns[1].finalAssistantMessage).toBeNull();
    expect(parsed.turns[1].toolEvidence[0]).toEqual(expect.objectContaining({ source: 'exec_command', content: 'verified state' }));
  });

  it('does not create a canonical turn without assistant or tool evidence', () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const path = transcript('empty', { id: 'empty', session_id: 'empty', cwd: '/work/project' }, 'none');
    expect(parseCodexTranscript(path).turns).toHaveLength(0);
  });

  it('keeps completed-turn fingerprints and recovery keys stable when a transcript is appended', () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const path = transcript('appendable', { id: 'appendable', session_id: 'appendable', cwd: '/work/project' });
    const before = parseCodexTranscript(path);
    const beforeKey = recoveryKeyFor(before, before.turns[0]);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n${line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'later-turn' } })}\n${line({ type: 'event_msg', payload: { type: 'user_message', message: 'later request' } })}\n${line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'later-turn', last_agent_message: 'later result' } })}`);
    const after = parseCodexTranscript(path);
    expect(after.transcriptSha256).not.toBe(before.transcriptSha256);
    expect(after.turns[0].sourceFingerprint).toBe(before.turns[0].sourceFingerprint);
    expect(recoveryKeyFor(after, after.turns[0])).toBe(beforeKey);
  });

  it('keeps the historical fingerprint schema stable after adding recovery metadata', () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const path = transcript('legacy-fingerprint', { id: 'legacy-fingerprint', session_id: 'legacy-fingerprint', cwd: '/work/project' });
    const parsed = parseCodexTranscript(path);
    const turn = parsed.turns[0];
    const expected = sha256Text(JSON.stringify({
      session: 'legacy-fingerprint', turn: turn.turnId, prompt: turn.promptNumber,
      user: turn.userMessage, assistant: turn.finalAssistantMessage, tools: turn.toolEvidence,
    }));
    expect(turn.sourceFingerprint).toBe(expected);
  });

  it('recovers sound evidence around a corrupt line, marks that turn incomplete, and preserves later turns', () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const path = join(root, 'middle-corruption.jsonl');
    writeFileSync(path, [
      line({ type: 'session_meta', payload: { id: 'corrupt', session_id: 'corrupt', cwd: '/work/project' } }),
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'bad-turn' } }),
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'damaged request' } }),
      '{"type":"response_item","payload":{"type":"function_call","arguments":"unterminated',
      line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'bad-turn', last_agent_message: 'must not be trusted' } }),
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'good-turn' } }),
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'sound request' } }),
      line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'good-turn', last_agent_message: 'sound result' } }),
    ].join('\n'));
    const parsed = parseCodexTranscript(path);
    expect(parsed.corruptions).toEqual([{ line: 4, turnId: 'bad-turn' }]);
    expect(parsed.turns.map(turn => turn.turnId)).toEqual(['bad-turn', 'good-turn']);
    expect(parsed.turns[0]).toEqual(expect.objectContaining({
      completionState: 'incomplete',
      corruptionLines: [4],
      finalAssistantMessage: 'must not be trusted',
    }));
    expect(parsed.turns[1].corruptionLines).toEqual([]);
  });

  it('recovers a real truncated subagent turn without treating missing bytes as evidence', () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const path = join(root, 'truncated-subagent.jsonl');
    writeFileSync(path, [
      line({ type: 'session_meta', payload: { id: 'child', session_id: 'root', parent_thread_id: 'root', cwd: '/work/project' } }),
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn' } }),
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'repair installation' } }),
      '{"type":"response_item","payload":{"type":"function_call_output","output":"truncated',
      line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Only the verified part is complete.' }] } }),
      line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'child-turn', last_agent_message: 'Only the verified part is complete.' } }),
    ].join('\n'));
    const parsed = parseCodexTranscript(path);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]).toEqual(expect.objectContaining({
      turnId: 'child-turn',
      completionState: 'incomplete',
      corruptionLines: [4],
      toolEvidence: [],
    }));
  });

  it('scans parents before children and a second scan creates zero new jobs', async () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const rootPath = transcript('root', { id: 'root', session_id: 'root', cwd: '/work/project' });
    const original = readFileSync(rootPath, 'utf8');
    writeFileSync(rootPath, `${original}\n${line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'root-turn-2' } })}\n${line({ type: 'event_msg', payload: { type: 'user_message', message: 'second root request' } })}\n${line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'root-turn-2', last_agent_message: 'second root result' } })}`);
    transcript('child', { id: 'child', session_id: 'root', parent_thread_id: 'root', cwd: '/work/project', source: { subagent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } } });
    transcript('grandchild', { id: 'grandchild', session_id: 'root', parent_thread_id: 'child', cwd: '/work/project', source: { subagent: { thread_spawn: { parent_thread_id: 'child', depth: 2 } } } });
    const store = new SessionStore(':memory:');
    const scanner = new HistoricalRecoveryScanner(store, undefined, root);
    const first = await scanner.scan();
    const second = await scanner.scan();
    expect(first.enqueued).toBe(4);
    expect(first.deadLetterCandidates).toHaveLength(0);
    expect(second.enqueued).toBe(0);
    expect(second.alreadyRepresented).toBe(4);
    expect((store.db.prepare('SELECT COUNT(*) n FROM recovery_jobs').get() as { n: number }).n).toBe(4);
    expect((store.db.prepare("SELECT COUNT(*) n FROM recovery_jobs WHERE project IN ('recovery','tmp')").get() as { n: number }).n).toBe(0);
  });

  it('cancels stale turn-mismatch dead letters even when the canonical turn is already represented', async () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    transcript('root', { id: 'root', session_id: 'root', cwd: '/work/project' });
    const store = new SessionStore(':memory:');
    await new HistoricalRecoveryScanner(store, undefined, root).scan(false);
    store.enqueueRecoveryJob({
      contentSessionId: 'root', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex',
      transcriptLocator: join(root, 'root.jsonl'), reason: 'malformed', recoveryKey: 'stale-key',
      sourceFingerprint: 'stale-fingerprint', promptNumber: 1, turnId: 'root-turn', nowEpoch: 100,
    });
    store.db.prepare("UPDATE recovery_jobs SET status='dead_letter', dead_letter_reason='turn_mismatch: stale', last_sanitized_error='turn_mismatch: stale' WHERE recovery_key='stale-key'").run();
    const report = await new HistoricalRecoveryScanner(store, undefined, root).scan(false);
    expect(report.alreadyRepresented).toBe(1);
    expect((store.db.prepare("SELECT status FROM recovery_jobs WHERE recovery_key='stale-key'").get() as { status: string }).status).toBe('cancelled');
    store.close();
  });

  it('requeues a cancelled exact-key job when its canonical turn has no valid summary representation', async () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const locator = transcript('root', { id: 'root', session_id: 'root', cwd: '/work/project' });
    const store = new SessionStore(':memory:');
    const parsed = parseCodexTranscript(locator);
    const turn = parsed.turns[0];
    const key = recoveryKeyFor(parsed, turn);
    const original = store.enqueueRecoveryJob({
      contentSessionId: 'root', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex',
      transcriptLocator: locator, reason: 'historical_summary_gap', recoveryKey: key,
      sourceFingerprint: turn.sourceFingerprint, promptNumber: turn.promptNumber, turnId: turn.turnId, nowEpoch: 100,
    });
    store.db.prepare("UPDATE recovery_jobs SET status='retry_wait', attempts=6, next_attempt_at_epoch=999_999 WHERE id=?").run(original.id);
    expect(store.cancelRecoveryJob(original.id, 200, 'historical_scan')).toBeTrue();

    const report = await new HistoricalRecoveryScanner(store, undefined, root).scan(false);
    expect(report).toEqual(expect.objectContaining({ eligible: 1, enqueued: 1, alreadyRepresented: 0 }));
    expect(store.getRecoveryJob(original.id)).toEqual(expect.objectContaining({
      status: 'pending', attempts: 0, completed_at_epoch: null, dead_letter_reason: null, cancellation_reason: null,
    }));
    expect((store.db.prepare('SELECT COUNT(*) n FROM recovery_jobs WHERE recovery_key=?').get(key) as { n: number }).n).toBe(1);
    store.close();
  });

  it('does not revive a cancelled job when its exact fingerprint already has a valid summary', async () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const locator = transcript('root', { id: 'root', session_id: 'root', cwd: '/work/project' });
    const store = new SessionStore(':memory:');
    const parsed = parseCodexTranscript(locator); const turn = parsed.turns[0]; const key = recoveryKeyFor(parsed, turn);
    const job = store.enqueueRecoveryJob({ contentSessionId: 'root', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex', transcriptLocator: locator, reason: 'historical_summary_gap', recoveryKey: key, sourceFingerprint: turn.sourceFingerprint, promptNumber: turn.promptNumber, turnId: turn.turnId, nowEpoch: 100 });
    expect(store.cancelRecoveryJob(job.id, 200, 'historical_scan')).toBeTrue();
    const session = store.upsertSessionLineage('root', 'project', 'codex', {}, 0);
    store.storeRecoverySummary(session.memory_session_id, 'project', { request: 'r', investigated: '', learned: '', completed: 'c', next_steps: '', notes: null }, turn.sourceFingerprint, turn.promptNumber, 300);

    const report = await new HistoricalRecoveryScanner(store, undefined, root).scan(false);
    expect(report).toEqual(expect.objectContaining({ enqueued: 0, alreadyRepresented: 1 }));
    expect(store.getRecoveryJob(job.id)).toEqual(expect.objectContaining({ status: 'cancelled', cancellation_reason: 'historical_scan' }));
    store.close();
  });

  it('does not revive a completed deterministic job without creating a duplicate', async () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const locator = transcript('root', { id: 'root', session_id: 'root', cwd: '/work/project' });
    const store = new SessionStore(':memory:');
    const parsed = parseCodexTranscript(locator); const turn = parsed.turns[0]; const key = recoveryKeyFor(parsed, turn);
    const job = store.enqueueRecoveryJob({ contentSessionId: 'root', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex', transcriptLocator: locator, reason: 'historical_summary_gap', recoveryKey: key, sourceFingerprint: turn.sourceFingerprint, promptNumber: turn.promptNumber, turnId: turn.turnId, nowEpoch: 100 });
    store.db.prepare("UPDATE recovery_jobs SET status='completed', completed_at_epoch=200 WHERE id=?").run(job.id);

    const report = await new HistoricalRecoveryScanner(store, undefined, root).scan(false);
    expect(report).toEqual(expect.objectContaining({ enqueued: 0, alreadyRepresented: 1 }));
    expect(store.getRecoveryJob(job.id)?.status).toBe('completed');
    expect((store.db.prepare('SELECT COUNT(*) n FROM recovery_jobs WHERE recovery_key=?').get(key) as { n: number }).n).toBe(1);
    store.close();
  });

  it('preserves an explicit operator cancellation during historical scans', async () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const locator = transcript('root', { id: 'root', session_id: 'root', cwd: '/work/project' });
    const store = new SessionStore(':memory:');
    const parsed = parseCodexTranscript(locator); const turn = parsed.turns[0]; const key = recoveryKeyFor(parsed, turn);
    const job = store.enqueueRecoveryJob({ contentSessionId: 'root', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex', transcriptLocator: locator, reason: 'historical_summary_gap', recoveryKey: key, sourceFingerprint: turn.sourceFingerprint, promptNumber: turn.promptNumber, turnId: turn.turnId, nowEpoch: 100 });
    expect(store.cancelRecoveryJob(job.id, 200)).toBeTrue();

    const report = await new HistoricalRecoveryScanner(store, undefined, root).scan(false);
    expect(report).toEqual(expect.objectContaining({ enqueued: 0, alreadyRepresented: 1 }));
    expect(store.getRecoveryJob(job.id)).toEqual(expect.objectContaining({ status: 'cancelled', cancellation_reason: 'manual' }));
    store.close();
  });

  it('treats an unknown cancellation reason as terminal without falsely counting an enqueue', async () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const locator = transcript('root', { id: 'root', session_id: 'root', cwd: '/work/project' });
    const store = new SessionStore(':memory:');
    const parsed = parseCodexTranscript(locator); const turn = parsed.turns[0]; const key = recoveryKeyFor(parsed, turn);
    const job = store.enqueueRecoveryJob({ contentSessionId: 'root', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex', transcriptLocator: locator, reason: 'historical_summary_gap', recoveryKey: key, sourceFingerprint: turn.sourceFingerprint, promptNumber: turn.promptNumber, turnId: turn.turnId, nowEpoch: 100 });
    expect(store.cancelRecoveryJob(job.id, 200, 'historical_scan')).toBeTrue();
    store.db.prepare("UPDATE recovery_jobs SET cancellation_reason='external_unknown' WHERE id=?").run(job.id);

    const report = await new HistoricalRecoveryScanner(store, undefined, root).scan(false);
    expect(report).toEqual(expect.objectContaining({ eligible: 0, enqueued: 0, alreadyRepresented: 1 }));
    expect(store.getRecoveryJob(job.id)).toEqual(expect.objectContaining({ status: 'cancelled', cancellation_reason: 'external_unknown' }));
    expect((store.db.prepare('SELECT COUNT(*) n FROM recovery_jobs WHERE recovery_key=?').get(key) as { n: number }).n).toBe(1);
    store.close();
  });

  it('enqueues only the requested oldest global turns while resolving child projects from parents', async () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    transcript('new-root', { id: 'new-root', session_id: 'new-root', cwd: '/work/newer' });
    const oldRoot = transcript('old-root', { id: 'old-root', session_id: 'old-root', cwd: '/work/older' });
    const child = transcript('old-child', { id: 'old-child', session_id: 'old-root', parent_thread_id: 'old-root', cwd: '/work/older', source: { subagent: { thread_spawn: { parent_thread_id: 'old-root', depth: 1 } } } });
    for (const [path, timestamp] of [[oldRoot, '2026-06-01'], [child, '2026-06-02']] as const) {
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('2026-07-01', timestamp));
    }
    const store = new SessionStore(':memory:');
    const report = await new HistoricalRecoveryScanner(store, undefined, root).scan(false, 2);
    const jobs = store.db.prepare('SELECT content_session_id FROM recovery_jobs ORDER BY created_at_epoch, id').all() as Array<{ content_session_id: string }>;
    expect(report.eligible).toBe(3);
    expect(report.enqueued).toBe(2);
    expect(jobs.map(job => job.content_session_id)).toEqual(['old-root', 'old-child']);
    expect((store.db.prepare("SELECT COUNT(*) n FROM recovery_jobs WHERE project IN ('recovery','tmp')").get() as { n: number }).n).toBe(0);
    store.close();
  });

  it('creates a release candidate set only from canonical turns inside the exact closed bounds', async () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    transcript('inside', { id: 'inside', session_id: 'inside', cwd: '/work/project' });
    const outside = transcript('outside', { id: 'outside', session_id: 'outside', cwd: '/work/project' });
    writeFileSync(outside, readFileSync(outside, 'utf8').replaceAll('2026-07-01T10:', '2026-07-01T11:'));
    const store = new SessionStore(':memory:');
    const report = await new HistoricalRecoveryScanner(store, undefined, root).scan(false, Number.POSITIVE_INFINITY, {
      startedAt: '2026-07-01T10:00:59.000Z', endedAt: '2026-07-01T10:01:01.000Z',
    });
    expect(report).toEqual(expect.objectContaining({ eligible: 1, enqueued: 1 }));
    expect(report.candidates).toHaveLength(1);
    expect((store.db.prepare('SELECT content_session_id FROM recovery_jobs').all() as Array<{ content_session_id: string }>).map(row => row.content_session_id)).toEqual(['inside']);
    store.close();
  });

  it('marks a bounded release scan incomplete when a canonical jsonl exceeds its size limit', async () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    transcript('oversized', { id: 'oversized', session_id: 'oversized', cwd: '/work/project' });
    const store = new SessionStore(':memory:');
    const report = await new HistoricalRecoveryScanner(store, { maxFiles: 10, maxFileBytes: 1, maxDurationMs: 10_000 }, root).scan(false, Number.POSITIVE_INFINITY, {
      startedAt: '2026-07-01T10:00:00.000Z', endedAt: '2026-07-01T10:03:00.000Z',
    });
    expect(report).toEqual(expect.objectContaining({ files: 0, eligible: 0, enqueued: 0, truncated: true }));
    store.close();
  });

  it('marks a bounded release scan incomplete for an invalid canonical turn timestamp', async () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const locator = transcript('untimed', { id: 'untimed', session_id: 'untimed', cwd: '/work/project' });
    writeFileSync(locator, readFileSync(locator, 'utf8').replaceAll('"timestamp":"2026-07-01T10:01:00Z"', '"timestamp":"not-a-time"'));
    const store = new SessionStore(':memory:');
    const report = await new HistoricalRecoveryScanner(store, undefined, root).scan(false, Number.POSITIVE_INFINITY, {
      startedAt: '2026-07-01T10:00:00.000Z', endedAt: '2026-07-01T10:03:00.000Z',
    });
    expect(report.truncated).toBeTrue();
    expect(report.deadLetterCandidates).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining('invalid_authoritative_timestamp') })]));
    expect(report.candidates).toEqual([]);
    store.close();
  });

  it('reuses an exact pending/retry recovery job as an actionable bounded-release candidate after restart', async () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    const locator = transcript('reentry', { id: 'reentry', session_id: 'reentry', cwd: '/work/project' });
    const store = new SessionStore(':memory:');
    const parsed = parseCodexTranscript(locator); const turn = parsed.turns[0]; const key = recoveryKeyFor(parsed, turn);
    const job = store.enqueueRecoveryJob({ contentSessionId: 'reentry', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex', transcriptLocator: locator, reason: 'release', recoveryKey: key, sourceFingerprint: turn.sourceFingerprint, promptNumber: turn.promptNumber, turnId: turn.turnId });
    store.db.prepare("UPDATE recovery_jobs SET status='retry_wait', next_attempt_at_epoch=? WHERE id=?").run(Date.now() + 60_000, job.id);
    const scanner = new HistoricalRecoveryScanner(store, undefined, root);
    const first = await scanner.scan(false, Number.POSITIVE_INFINITY, { startedAt: '2026-07-01T10:00:00.000Z', endedAt: '2026-07-01T10:03:00.000Z' });
    const second = await scanner.scan(false, Number.POSITIVE_INFINITY, { startedAt: '2026-07-01T10:00:00.000Z', endedAt: '2026-07-01T10:03:00.000Z' });
    expect(first.candidates).toEqual([{ recoveryKey: key, sourceFingerprint: turn.sourceFingerprint, disposition: 'job' }]);
    expect(second.candidates).toEqual(first.candidates);
    expect(store.getRecoveryJob(job.id)).toEqual(expect.objectContaining({ status: 'retry_wait', next_attempt_at_epoch: expect.any(Number) }));
    expect(store.getRecoveryJob(job.id)!.next_attempt_at_epoch).toBeLessThanOrEqual(Date.now());
    expect((store.db.prepare('SELECT COUNT(*) n FROM recovery_jobs WHERE recovery_key=?').get(key) as { n: number }).n).toBe(1);
    store.close();
  });

  it('defers recently modified transcripts when the production stability gate is enabled', async () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-recovery-'));
    transcript('active', { id: 'active', session_id: 'active', cwd: '/work/project' });
    const store = new SessionStore(':memory:');
    const report = await new HistoricalRecoveryScanner(store, undefined, root, 5 * 60_000).scan(false);
    expect(report).toEqual(expect.objectContaining({ files: 1, validTranscripts: 0, unstableTranscripts: 1, eligible: 0, enqueued: 0 }));
    expect((store.db.prepare('SELECT COUNT(*) n FROM recovery_jobs').get() as { n: number }).n).toBe(0);
    store.close();
  });

  it('smoke-parses a bounded sample of real main and subagent envelopes when available', () => {
    const files = globSync('/root/.codex/sessions/**/*.jsonl').sort();
    if (!files.length) return;
    const selected: string[] = [];
    for (const path of files) {
      const head = readFileSync(path, 'utf8').split(/\r?\n/, 2)[0] ?? '';
      const isSubagent = head.includes('"subagent"');
      if (!selected.some(item => readFileSync(item, 'utf8').split(/\r?\n/, 2)[0]?.includes('"subagent"') === isSubagent)) selected.push(path);
      if (selected.length === 2) break;
    }
    for (const path of selected) {
      const parsed = parseCodexTranscript(path);
      expect(parsed.lineage.contentSessionId.length).toBeGreaterThan(0);
      expect(parsed.lineage.rootContentSessionId.length).toBeGreaterThan(0);
      expect(parsed.turns.every(turn => Boolean(turn.finalAssistantMessage) || turn.toolEvidence.length > 0)).toBeTrue();
      expect(parsed.turns.every(turn => turn.toolEvidence.every(item => Boolean(item.callId && item.source)))).toBeTrue();
    }
  });
});
