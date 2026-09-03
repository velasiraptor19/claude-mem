import { describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('SessionStore recovery lineage', () => {
  it('adds lineage columns without losing an existing session and remains idempotent', () => {
    const store = new SessionStore(':memory:');
    const id = store.createSDKSession('existing', '/repo', 'prompt', undefined, 'codex');
    store.upsertSessionLineage('child', 'repo', 'codex', { parentContentSessionId: 'existing', rootContentSessionId: 'existing', agentId: 'child', agentType: 'subagent', agentDepth: 1, transcriptLocator: '/x.jsonl' });
    store.upsertSessionLineage('child', 'repo', 'codex', { agentNickname: 'Ada' });
    const existing = store.getSessionById(id);
    const child = store.db.prepare('SELECT * FROM sdk_sessions WHERE content_session_id=?').get('child') as any;
    expect(existing?.content_session_id).toBe('existing');
    expect(child).toEqual(expect.objectContaining({ parent_content_session_id: 'existing', root_content_session_id: 'existing', agent_id: 'child', agent_depth: 1, agent_nickname: 'Ada' }));
  });

  it('stores a fingerprint once under the child session, never the parent', () => {
    const store = new SessionStore(':memory:');
    const parent = store.upsertSessionLineage('parent', 'repo', 'codex', {});
    const child = store.upsertSessionLineage('child', 'repo', 'codex', { parentContentSessionId: 'parent', rootContentSessionId: 'parent', agentId: 'child' });
    const summary = { request: 'r', investigated: 'i', learned: 'l', completed: 'c', next_steps: 'n', notes: null };
    const first = store.storeRecoverySummary(child.memory_session_id, 'repo', summary, 'fingerprint', 1, 1000);
    const second = store.storeRecoverySummary(child.memory_session_id, 'repo', summary, 'fingerprint', 1, 1000);
    expect(first.inserted).toBe(true); expect(second.inserted).toBe(false); expect(first.id).toBe(second.id);
    expect((store.db.prepare('SELECT memory_session_id FROM session_summaries WHERE id=?').get(first.id) as any).memory_session_id).toBe(child.memory_session_id);
    expect(store.getSummaryForSession(parent.memory_session_id)).toBeNull();
  });
});
