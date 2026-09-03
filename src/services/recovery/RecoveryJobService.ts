import type { EnqueueRecoveryJobInput, RecoveryJobRecord } from '../../types/database.js';
import type { SessionStore } from '../sqlite/SessionStore.js';

export class RecoveryJobService {
  constructor(private readonly store: SessionStore) {}

  enqueue(input: EnqueueRecoveryJobInput): RecoveryJobRecord {
    return this.store.enqueueRecoveryJob(input);
  }

  claimOldest(leaseOwner: string, leaseDurationMs: number, nowEpoch?: number): RecoveryJobRecord | null {
    return this.store.claimOldestRecoveryJob(leaseOwner, leaseDurationMs, nowEpoch);
  }

  claimByKey(recoveryKey: string, leaseOwner: string, leaseDurationMs: number, nowEpoch?: number): RecoveryJobRecord | null {
    return this.store.claimRecoveryJobByKey(recoveryKey, leaseOwner, leaseDurationMs, nowEpoch);
  }

  releaseExpiredLeases(nowEpoch?: number): number {
    return this.store.releaseExpiredRecoveryLeases(nowEpoch);
  }

  retryLater(jobId: number, leaseOwner: string, nextAttemptAtEpoch: number, sanitizedError: string, nowEpoch?: number): boolean {
    return this.store.markRecoveryJobRetryWait(jobId, leaseOwner, nextAttemptAtEpoch, sanitizedError, nowEpoch);
  }

  complete(jobId: number, leaseOwner: string, nowEpoch?: number): boolean {
    return this.store.markRecoveryJobCompleted(jobId, leaseOwner, nowEpoch);
  }

  renewLease(jobId: number, leaseOwner: string, leaseDurationMs: number, nowEpoch?: number): boolean {
    return this.store.renewRecoveryJobLease(jobId, leaseOwner, leaseDurationMs, nowEpoch);
  }

  cancel(jobId: number, nowEpoch?: number): boolean {
    return this.store.cancelRecoveryJob(jobId, nowEpoch);
  }

  resumeDeadLetter(jobId: number, nowEpoch?: number): boolean {
    return this.store.resumeDeadLetterRecoveryJob(jobId, nowEpoch);
  }

  deadLetterMissingTranscript(jobId: number, transcriptLocator: string | null, nowEpoch?: number, leaseOwner?: string): boolean {
    const locator = transcriptLocator?.trim() || '<unset>';
    return this.store.markRecoveryJobDeadLetter(
      jobId,
      `Canonical transcript is missing or unreadable at ${locator}; restore the transcript or update its locator before retrying recovery.`,
      nowEpoch,
      leaseOwner
    );
  }
}
