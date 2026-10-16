import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { RecoveryJobService } from '../../src/services/recovery/RecoveryJobService.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('SessionStore recovery jobs', () => {
  let store: SessionStore;
  let service: RecoveryJobService;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    service = new RecoveryJobService(store);
  });

  afterEach(() => store.close());

  const enqueue = (contentSessionId: string, nowEpoch: number, recoveryKind = 'session_summary') => service.enqueue({
    contentSessionId,
    recoveryKind,
    project: 'crawl4ai',
    platformSource: 'codex',
    transcriptLocator: `/transcripts/${contentSessionId}.jsonl`,
    reason: 'summary missing',
    provider: 'nvidia',
    model: 'nemotron',
    sanitizedError: 'invalid XML',
    nowEpoch,
  });

  it('migrates a fresh database with the recovery_jobs schema and active uniqueness', () => {
    expect(store.db.prepare("SELECT version FROM schema_versions WHERE version = 50").get()).toBeTruthy();
    expect(store.db.prepare("SELECT version FROM schema_versions WHERE version = 53").get()).toBeTruthy();
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recovery_jobs'").get())
      .toEqual({ name: 'recovery_jobs' });

    const indexes = store.db.query('PRAGMA index_list(recovery_jobs)').all() as Array<{ name: string; unique: number; partial: number }>;
    expect(indexes).toContainEqual(expect.objectContaining({
      name: 'ux_recovery_jobs_key',
      unique: 1,
      partial: 0,
    }));
    expect(indexes).toContainEqual(expect.objectContaining({
      name: 'idx_recovery_jobs_active_session_kind',
      unique: 0,
      partial: 1,
    }));
    const columns = store.db.query('PRAGMA table_info(recovery_jobs)').all() as Array<{ name: string }>;
    expect(columns.some(column => column.name === 'cancellation_reason')).toBeTrue();
  });

  it('recreates recovery schema despite existing upstream version stamps', () => {
    store.db.run('DROP TABLE recovery_jobs');

    expect(() => new SessionStore(store.db)).not.toThrow();
    expect(() => new SessionStore(store.db)).not.toThrow();
    expect(store.db.prepare("SELECT version FROM schema_versions WHERE version = 50").get()).toBeTruthy();
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recovery_jobs'").get())
      .toEqual({ name: 'recovery_jobs' });
  });

  it('repairs the v53 cancellation column atomically even when an old database was incorrectly stamped as migrated', () => {
    store.db.run('ALTER TABLE recovery_jobs DROP COLUMN cancellation_reason');
    // Reproduce an interrupted/competing legacy initializer: the version row
    // exists even though the schema invariant was not completed.
    expect(store.db.prepare("SELECT version FROM schema_versions WHERE version = 53").get()).toBeTruthy();

    expect(() => new SessionStore(store.db)).not.toThrow();
    expect(() => new SessionStore(store.db)).not.toThrow();
    const columns = store.db.query('PRAGMA table_info(recovery_jobs)').all() as Array<{ name: string }>;
    expect(columns.some(column => column.name === 'cancellation_reason')).toBeTrue();
    expect(store.db.prepare("SELECT version FROM schema_versions WHERE version = 53").get()).toBeTruthy();
  });

  it('coalesces duplicate active jobs without losing first-failure age', () => {
    const first = enqueue('session-a', 1_000);
    const second = service.enqueue({
      contentSessionId: 'session-a',
      recoveryKind: 'session_summary',
      project: 'renamed-project',
      platformSource: 'codex',
      transcriptLocator: '/new/location.jsonl',
      reason: 'second failure',
      sanitizedError: 'still malformed',
      nowEpoch: 2_000,
      nextAttemptAtEpoch: 3_000,
    });

    expect(second.id).toBe(first.id);
    expect(second.first_failure_at_epoch).toBe(1_000);
    expect(second.last_failure_at_epoch).toBe(2_000);
    expect(second.reason).toBe('second failure');
    expect(second.transcript_locator).toBe('/new/location.jsonl');
    expect((store.db.prepare('SELECT COUNT(*) AS count FROM recovery_jobs').get() as { count: number }).count).toBe(1);

    store.markRecoveryJobDeadLetter(first.id, 'terminal', 2_100);
    const replacement = enqueue('session-a', 2_200);
    expect(replacement.id).not.toBe(first.id);
  });

  it('repairs a stale v51 unique session index and permits one deterministic job per turn', () => {
    store.db.run(`
      DROP INDEX IF EXISTS idx_recovery_jobs_active_session_kind;
      CREATE UNIQUE INDEX ux_recovery_jobs_active_session_kind
        ON recovery_jobs(content_session_id, recovery_kind)
        WHERE status IN ('pending', 'running', 'retry_wait');
    `);
    const reopened = new SessionStore(store.db);
    const base = {
      contentSessionId: 'multi-turn', recoveryKind: 'session_summary', project: 'crawl4ai',
      platformSource: 'codex', reason: 'historical gap', nowEpoch: 1_000,
    };
    const first = reopened.enqueueRecoveryJob({ ...base, recoveryKey: 'turn-1', promptNumber: 1 });
    const second = reopened.enqueueRecoveryJob({ ...base, recoveryKey: 'turn-2', promptNumber: 2 });
    expect(second.id).not.toBe(first.id);
    expect(reopened.db.prepare("SELECT name FROM pragma_index_list('recovery_jobs') WHERE name='ux_recovery_jobs_active_session_kind'").get()).toBeNull();
  });

  it('claims eligible jobs oldest-first and increments attempts under a lease', () => {
    const newer = enqueue('newer', 2_000);
    const oldest = enqueue('oldest', 1_000);

    const claimed = service.claimOldest('worker-1', 500, 3_000);
    expect(claimed?.id).toBe(oldest.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.lease_owner).toBe('worker-1');
    expect(claimed?.lease_expires_at_epoch).toBe(3_500);
    expect(store.getRecoveryJob(newer.id)?.status).toBe('pending');
  });

  it('claims an exact persisted plan key without consuming an unrelated older job', () => {
    const older = enqueue('unrelated-older', 1_000);
    const planned = enqueue('release-plan-job', 2_000);
    const claimed = service.claimByKey(planned.recovery_key, 'release-worker', 500, 3_000);
    expect(claimed?.id).toBe(planned.id);
    expect(claimed?.recovery_key).toBe(planned.recovery_key);
    expect(store.getRecoveryJob(older.id)?.status).toBe('pending');
  });

  it('releases an expired lease and makes the crashed job claimable again', () => {
    const job = enqueue('crashed', 1_000);
    expect(service.claimOldest('dead-worker', 100, 1_000)?.id).toBe(job.id);

    expect(store.releaseExpiredRecoveryLeases(1_099)).toBe(0);
    expect(store.releaseExpiredRecoveryLeases(1_100)).toBe(1);
    expect(store.getRecoveryJob(job.id)).toEqual(expect.objectContaining({
      status: 'retry_wait',
      lease_owner: null,
      lease_expires_at_epoch: null,
    }));

    const reclaimed = service.claimOldest('replacement-worker', 100, 1_100);
    expect(reclaimed).toEqual(expect.objectContaining({ id: job.id, status: 'running', attempts: 2 }));
  });

  it('enforces leased retry/completed transitions and supports cancellation', () => {
    const retryJob = enqueue('retry', 1_000);
    service.claimOldest('worker', 500, 1_000);
    expect(store.markRecoveryJobRetryWait(retryJob.id, 'wrong-worker', 2_000, 'transient', 1_100)).toBe(false);
    expect(store.markRecoveryJobRetryWait(retryJob.id, 'worker', 2_000, 'transient', 1_100)).toBe(true);
    expect(store.getRecoveryJob(retryJob.id)).toEqual(expect.objectContaining({
      status: 'retry_wait', next_attempt_at_epoch: 2_000, last_sanitized_error: 'transient',
    }));

    expect(service.claimOldest('worker', 500, 1_999)).toBeNull();
    expect(service.claimOldest('worker', 500, 2_000)?.id).toBe(retryJob.id);
    expect(store.markRecoveryJobCompleted(retryJob.id, 'worker', 2_100)).toBe(true);
    expect(store.getRecoveryJob(retryJob.id)).toEqual(expect.objectContaining({
      status: 'completed', completed_at_epoch: 2_100,
    }));

    const cancelled = enqueue('cancel', 3_000);
    expect(store.cancelRecoveryJob(cancelled.id, 3_100)).toBe(true);
    expect(store.getRecoveryJob(cancelled.id)?.status).toBe('cancelled');
  });

  it('reopens only legacy or allowlisted automatic cancellations with a fresh retry budget', () => {
    const first = service.enqueue({
      contentSessionId: 'cancelled-key', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex',
      reason: 'historical_summary_gap', recoveryKey: 'turn-key', sourceFingerprint: 'fingerprint', promptNumber: 1, turnId: 'turn-1', nowEpoch: 1_000,
    });
    store.db.prepare("UPDATE recovery_jobs SET status='retry_wait', attempts=6, next_attempt_at_epoch=99_999 WHERE id=?").run(first.id);
    expect(store.cancelRecoveryJob(first.id, 1_100, 'historical_scan')).toBeTrue();

    const reopened = service.enqueue({
      contentSessionId: 'cancelled-key', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex',
      reason: 'historical_summary_gap', recoveryKey: 'turn-key', sourceFingerprint: 'fingerprint', promptNumber: 1, turnId: 'turn-1', nowEpoch: 1_200,
    });
    expect(reopened).toEqual(expect.objectContaining({ id: first.id, status: 'pending', attempts: 0, next_attempt_at_epoch: 1_200, completed_at_epoch: null, cancellation_reason: null }));
    expect((store.db.prepare("SELECT COUNT(*) AS count FROM recovery_jobs WHERE recovery_key='turn-key'").get() as { count: number }).count).toBe(1);

    expect(service.cancel(first.id, 1_300)).toBeTrue();
    const manual = service.enqueue({
      contentSessionId: 'cancelled-key', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex',
      reason: 'historical_summary_gap', recoveryKey: 'turn-key', sourceFingerprint: 'fingerprint', promptNumber: 1, turnId: 'turn-1', nowEpoch: 1_400,
    });
    expect(manual).toEqual(expect.objectContaining({ id: first.id, status: 'cancelled', cancellation_reason: 'manual' }));

    // Unknown provenance is intentionally fail-closed: only NULL legacy rows
    // and explicit automatic reasons are eligible for historical revival.
    store.db.prepare("UPDATE recovery_jobs SET cancellation_reason='external_unknown' WHERE id=?").run(first.id);
    const unknown = service.enqueue({
      contentSessionId: 'cancelled-key', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex',
      reason: 'historical_summary_gap', recoveryKey: 'turn-key', sourceFingerprint: 'fingerprint', promptNumber: 1, turnId: 'turn-1', nowEpoch: 1_500,
    });
    expect(unknown).toEqual(expect.objectContaining({ id: first.id, status: 'cancelled', cancellation_reason: 'external_unknown' }));

    // Pre-v53 rows carry NULL and remain recoverable, preserving the historical
    // backfill guarantee without treating future unknown reasons as automatic.
    store.db.prepare('UPDATE recovery_jobs SET cancellation_reason=NULL WHERE id=?').run(first.id);
    const legacy = service.enqueue({
      contentSessionId: 'cancelled-key', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex',
      reason: 'historical_summary_gap', recoveryKey: 'turn-key', sourceFingerprint: 'fingerprint', promptNumber: 1, turnId: 'turn-1', nowEpoch: 1_600,
    });
    expect(legacy).toEqual(expect.objectContaining({ id: first.id, status: 'pending', attempts: 0, cancellation_reason: null }));
  });

  it('dead-letters a missing transcript with an actionable sanitized reason', () => {
    const job = enqueue('missing', 1_000);
    service.claimOldest('worker', 500, 1_000);

    expect(service.deadLetterMissingTranscript(job.id, job.transcript_locator, 1_100, 'worker')).toBe(true);
    const dead = store.getRecoveryJob(job.id)!;
    expect(dead.status).toBe('dead_letter');
    expect(dead.completed_at_epoch).toBe(1_100);
    expect(dead.last_sanitized_error).toContain('Canonical transcript is missing or unreadable');
    expect(dead.last_sanitized_error).toContain('/transcripts/missing.jsonl');
  });

  it('resumes only evidence-addressable dead letters and preserves attempt history', () => {
    const store = new SessionStore(':memory:');
    const resumable = store.enqueueRecoveryJob({
      contentSessionId: 'resume-me', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex',
      transcriptLocator: '/tmp/resume.jsonl', reason: 'historical_summary_gap', sourceFingerprint: 'fp',
      promptNumber: 3, turnId: 'turn-3', nowEpoch: 100,
    });
    expect(store.markRecoveryJobDeadLetter(resumable.id, 'bad xml', 200)).toBeTrue();
    expect(store.resumeDeadLetterRecoveryJob(resumable.id, 300)).toBeTrue();
    expect(store.getRecoveryJob(resumable.id)).toEqual(expect.objectContaining({
      status: 'pending', attempts: 0, next_attempt_at_epoch: 300,
      completed_at_epoch: null, dead_letter_reason: null, last_sanitized_error: 'bad xml',
    }));
    expect(store.resumeDeadLetterRecoveryJob(resumable.id, 400)).toBeFalse();

    const legacy = store.enqueueRecoveryJob({
      contentSessionId: 'legacy', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex',
      reason: 'legacy', nowEpoch: 500,
    });
    expect(store.markRecoveryJobDeadLetter(legacy.id, 'missing metadata', 600)).toBeTrue();
    expect(store.resumeDeadLetterRecoveryJob(legacy.id, 700)).toBeFalse();
    store.close();
  });

  it('cancels only stale turn-mismatch snapshots after a canonical replacement exists', () => {
    const store = new SessionStore(':memory:');
    const stale = store.enqueueRecoveryJob({ contentSessionId: 'live', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex', transcriptLocator: '/tmp/live.jsonl', reason: 'malformed', recoveryKey: 'old-key', sourceFingerprint: 'old-fp', promptNumber: 9, turnId: 'turn-9', nowEpoch: 100 });
    expect(store.markRecoveryJobDeadLetter(stale.id, 'turn_mismatch: exact fingerprint changed', 200)).toBeTrue();
    const unrelated = store.enqueueRecoveryJob({ contentSessionId: 'live', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex', transcriptLocator: '/tmp/live.jsonl', reason: 'malformed', recoveryKey: 'other-key', sourceFingerprint: 'other-fp', promptNumber: 8, turnId: 'turn-8', nowEpoch: 100 });
    expect(store.markRecoveryJobDeadLetter(unrelated.id, 'malformed_or_unrecoverable:xml', 200)).toBeTrue();
    expect(store.cancelSupersededTurnMismatchJobs('codex', 'live', 9, 'turn-9', 'new-fp', 300)).toBe(1);
    expect(store.getRecoveryJob(stale.id)).toEqual(expect.objectContaining({ status: 'cancelled', cancellation_reason: 'superseded_turn_mismatch' }));
    expect(store.getRecoveryJob(unrelated.id)?.status).toBe('dead_letter');

    const revived = store.enqueueRecoveryJob({ contentSessionId: 'live', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex', transcriptLocator: '/tmp/live.jsonl', reason: 'historical gap', recoveryKey: 'old-key', sourceFingerprint: 'old-fp', promptNumber: 9, turnId: 'turn-9', nowEpoch: 400 });
    expect(revived).toEqual(expect.objectContaining({ id: stale.id, status: 'pending', attempts: 0, cancellation_reason: null }));
    expect((store.db.prepare("SELECT COUNT(*) AS count FROM recovery_jobs WHERE recovery_key='old-key'").get() as { count: number }).count).toBe(1);
    store.close();
  });
});
