import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionCompletionHandler } from '../../src/services/worker/session/SessionCompletionHandler.js';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

describe('SessionCompletionHandler recovery gaps', () => {
  it('queues every canonical prompt with a fingerprint even when memory_session_id is null', async () => {
    root = mkdtempSync(join(tmpdir(), 'cmem-completion-gaps-'));
    const locator = join(root, 'session.jsonl');
    const rows: unknown[] = [{ type: 'session_meta', payload: { id: 'all-turns', session_id: 'all-turns', cwd: '/work/project' } }];
    for (let n = 1; n <= 3; n++) rows.push(
      { type: 'event_msg', payload: { type: 'task_started', turn_id: `turn-${n}` } },
      { type: 'event_msg', payload: { type: 'user_message', message: `request-${n}` } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: `turn-${n}`, last_agent_message: `result-${n}` } },
    );
    writeFileSync(locator, rows.map(row => JSON.stringify(row)).join('\n'));
    const store = new SessionStore(':memory:');
    const id = store.createSDKSession('all-turns', 'project', 'request-1', undefined, 'codex');
    store.db.prepare('UPDATE sdk_sessions SET transcript_locator=? WHERE id=?').run(locator, id);
    const handler = new SessionCompletionHandler({} as any, { broadcastSessionCompleted() {} } as any, { getSessionStore: () => store } as any);
    await handler.finalizeSession(id);
    const jobs = store.db.prepare('SELECT prompt_number, source_fingerprint, recovery_key FROM recovery_jobs ORDER BY prompt_number').all() as Array<Record<string, unknown>>;
    expect(jobs.map(job => job.prompt_number)).toEqual([1, 2, 3]);
    expect(jobs.every(job => typeof job.source_fingerprint === 'string' && typeof job.recovery_key === 'string')).toBeTrue();
    await handler.finalizeSession(id);
    expect((store.db.prepare('SELECT COUNT(*) n FROM recovery_jobs').get() as { n: number }).n).toBe(3);
  });
});
