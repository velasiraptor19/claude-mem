import { describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { LATEST_SCHEMA_VERSION } from '../../src/services/sqlite/connection.js';

describe('maintained recovery schema upgrade', () => {
  it('does not let upstream version stamps skip recovery schema on an upstream store', () => {
    const store = new SessionStore(':memory:');
    try {
      store.db.run('DROP TABLE recovery_jobs; DROP TABLE historical_summary_representations');
      store.db.run('DROP INDEX ux_session_summaries_source_fingerprint');
      store.db.run('ALTER TABLE session_summaries DROP COLUMN source_fingerprint');
      store.db.run('DROP INDEX idx_sdk_sessions_parent; DROP INDEX idx_sdk_sessions_root');
      for (const name of ['parent_content_session_id', 'root_content_session_id', 'agent_id', 'agent_type', 'agent_path', 'agent_nickname', 'agent_depth', 'transcript_locator']) {
        store.db.run(`ALTER TABLE sdk_sessions DROP COLUMN ${name}`);
      }
      new SessionStore(store.db);
      const session = store.upsertSessionLineage('child', 'repo', 'codex', { parentContentSessionId: 'parent', agentId: 'agent' });
      expect(store.db.query('SELECT parent_content_session_id FROM sdk_sessions WHERE id = ?').get(session.id)).toEqual({ parent_content_session_id: 'parent' });
      expect(store.db.query('SELECT * FROM historical_summary_representations').all()).toEqual([]);
      expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { store.close(); }
  });

  it('preserves maintained lineage and fingerprint data while applying colliding upstream migrations', () => {
    const store = new SessionStore(':memory:');
    try {
      const session = store.upsertSessionLineage('child', 'repo', 'codex', { parentContentSessionId: 'parent', rootContentSessionId: 'root', agentId: 'agent', transcriptLocator: '/bounded.jsonl' });
      const summary = store.storeRecoverySummary(session.memory_session_id, 'repo', {
        request: 'request', investigated: 'investigated', learned: 'learned', completed: 'completed', next_steps: 'next', notes: null,
      }, 'preserved-fingerprint', 1, 1000);
      store.db.run(`INSERT INTO historical_summary_representations VALUES ('representation', ?, 'original', 'child', 1, 1000)`, [summary.id]);
      const job = store.enqueueRecoveryJob({ contentSessionId: 'child', project: 'repo', platformSource: 'codex', recoveryKind: 'session_summary', reason: 'gap', recoveryKey: 'stable-key', sourceFingerprint: 'preserved-fingerprint', nowEpoch: 1000 });
      // Reproduce the old maintained 50–53 claims while upstream's corresponding DDL is absent.
      store.db.run('DROP TABLE tool_uses; DROP TABLE telegram_wrapups');
      store.db.run('DROP INDEX idx_sdk_sessions_cwd; ALTER TABLE sdk_sessions DROP COLUMN cwd');
      store.db.run('DELETE FROM schema_versions WHERE version > 53; PRAGMA user_version = 0');
      new SessionStore(store.db);
      new SessionStore(store.db);
      expect(store.db.query('SELECT parent_content_session_id, root_content_session_id, agent_id FROM sdk_sessions WHERE id = ?').get(session.id))
        .toEqual({ parent_content_session_id: 'parent', root_content_session_id: 'root', agent_id: 'agent' });
      expect(store.db.query('SELECT source_fingerprint FROM session_summaries WHERE id = ?').get(summary.id)).toEqual({ source_fingerprint: 'preserved-fingerprint' });
      expect(store.getRecoveryJob(job.id)?.recovery_key).toBe('stable-key');
      expect(store.db.query('SELECT COUNT(*) AS n FROM historical_summary_representations').get()).toEqual({ n: 1 });
      expect(store.db.query('SELECT COUNT(*) AS n FROM tool_uses').get()).toEqual({ n: 0 });
      expect(store.db.query('SELECT COUNT(*) AS n FROM telegram_wrapups').get()).toEqual({ n: 0 });
      expect(store.db.query('SELECT cwd FROM sdk_sessions WHERE id = ?').get(session.id)).toEqual({ cwd: null });
      expect(store.db.query('PRAGMA user_version').get()).toEqual({ user_version: LATEST_SCHEMA_VERSION });
      expect(store.db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { store.close(); }
  });
});
