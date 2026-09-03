
import { SessionManager } from '../SessionManager.js';
import { SessionEventBroadcaster } from '../events/SessionEventBroadcaster.js';
import { DatabaseManager } from '../DatabaseManager.js';
import { logger } from '../../../utils/logger.js';
import { RecoveryJobService } from '../../recovery/RecoveryJobService.js';
import { parseCodexTranscriptAsync, recoveryKeyFor } from '../../recovery/CodexTranscriptRecovery.js';

export class SessionCompletionHandler {
  constructor(
    private sessionManager: SessionManager,
    private eventBroadcaster: SessionEventBroadcaster,
    private dbManager: DatabaseManager
  ) {}

  async finalizeSession(sessionDbId: number): Promise<void> {
    const sessionStore = this.dbManager.getSessionStore();

    const row = sessionStore.getSessionById(sessionDbId);
    if (!row) {
      logger.debug('SESSION', 'finalizeSession: session not found, skipping', { sessionId: sessionDbId });
      return;
    }
    if (row.status === 'completed') {
      logger.debug('SESSION', 'finalizeSession: already completed, skipping', { sessionId: sessionDbId });
      return;
    }

    sessionStore.markSessionCompleted(sessionDbId);

    if (row.platform_source === 'codex' && row.transcript_locator) {
      try {
        const transcript = await parseCodexTranscriptAsync(row.transcript_locator);
        let queued = 0;
        for (const turn of transcript.turns) {
          const represented = sessionStore.hasSummaryFingerprint(turn.sourceFingerprint)
            || !!sessionStore.db.prepare('SELECT 1 FROM historical_summary_representations WHERE source_fingerprint=? LIMIT 1').get(turn.sourceFingerprint);
          if (represented) continue;
          new RecoveryJobService(sessionStore).enqueue({
        contentSessionId: row.content_session_id, recoveryKind: 'session_summary', project: row.project,
        platformSource: row.platform_source, transcriptLocator: row.transcript_locator,
            reason: 'session_completed_with_summary_gap', recoveryKey: recoveryKeyFor(transcript, turn),
            sourceFingerprint: turn.sourceFingerprint, promptNumber: turn.promptNumber, turnId: turn.turnId,
            transcriptSha256: transcript.transcriptSha256,
            parentContentSessionId: transcript.lineage.parentContentSessionId,
            rootContentSessionId: transcript.lineage.rootContentSessionId,
            agentId: transcript.lineage.agentId,
          });
          queued += 1;
        }
        if (queued) logger.warn('SESSION', 'Completed session has summary gaps; queued durable recovery', { sessionId: sessionDbId, contentSessionId: row.content_session_id, queued });
      } catch (error) {
        logger.warn('SESSION', 'Could not canonicalize completion gaps; historical scanner required', { sessionId: sessionDbId, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // The in-RAM message buffer is dropped when the session is removed
    // (SessionManager.removeSessionImmediate/deleteSession → buffer.dispose),
    // so there is nothing durable to clear here.

    this.eventBroadcaster.broadcastSessionCompleted(sessionDbId);

    logger.info('SESSION', 'Session finalized', { sessionId: sessionDbId });
  }
}
