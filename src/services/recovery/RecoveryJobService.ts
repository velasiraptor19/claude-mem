import { parseCodexTranscriptAsync, recoveryKeyFor } from './CodexTranscriptRecovery.js';
import type { EnqueueRecoveryJobInput, RecoveryJobRecord } from '../../types/database.js';
import type { SessionStore } from '../sqlite/SessionStore.js';

export class RecoveryJobService {
  constructor(private readonly store: SessionStore) {}

  enqueue(input: EnqueueRecoveryJobInput): RecoveryJobRecord {
    return this.store.enqueueRecoveryJob(input);
  }

  async enqueueMalformedBatch(session: { content_session_id: string; platform_source: string; transcript_locator: string | null; project: string }, messages: ReadonlyArray<{ prompt_number?: number }>, reason: string): Promise<RecoveryJobRecord[]> {
    if (session.platform_source !== 'codex' || !session.transcript_locator) throw new Error('Canonical Codex transcript required for malformed recovery');
    const transcript = await parseCodexTranscriptAsync(session.transcript_locator);
    if (transcript.lineage.contentSessionId !== session.content_session_id) throw new Error('Canonical recovery session mismatch');
    const prompts = [...new Set(messages.map(message => message.prompt_number))];
    if (prompts.length === 0 || prompts.some(prompt => !Number.isSafeInteger(prompt) || prompt! < 1)) throw new Error('Canonical recovery prompt required');
    const turns = prompts.map(prompt => {
      const matches = transcript.turns.filter(turn => turn.promptNumber === prompt);
      if (matches.length !== 1) throw new Error('Canonical recovery turn missing or ambiguous');
      return matches[0];
    });
    return this.store.db.transaction(() => turns.map(turn => this.enqueue({
      contentSessionId: session.content_session_id, platformSource: 'codex', project: session.project,
      recoveryKind: 'session_summary', transcriptLocator: transcript.locator, reason,
      recoveryKey: recoveryKeyFor(transcript, turn), sourceFingerprint: turn.sourceFingerprint,
      promptNumber: turn.promptNumber, turnId: turn.turnId, transcriptSha256: transcript.transcriptSha256,
      parentContentSessionId: transcript.lineage.parentContentSessionId,
      rootContentSessionId: transcript.lineage.rootContentSessionId, agentId: transcript.lineage.agentId,
    })))();
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
