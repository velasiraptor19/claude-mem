import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { isClassified } from '../worker/provider-errors.js';
import type { DatabaseManager } from '../worker/DatabaseManager.js';
import type { NvidiaProvider } from '../worker/NvidiaProvider.js';
import type { RecoveryJobRecord } from '../../types/database.js';
import { RecoveryJobService } from './RecoveryJobService.js';
import { parseCodexTranscript } from './CodexTranscriptRecovery.js';

export interface RecoveryConsumerStatus { running: boolean; activeJobId: number | null; processed: number; }

const LEASE_MS = 180_000;
const HEARTBEAT_MS = 45_000;
const MAX_TRANSIENT_ATTEMPTS = 6;
const MAX_QUOTA_ATTEMPTS = 4;
const MAX_AUTH_ATTEMPTS = 2;
// Quota exhaustion usually has no reliable reset signal. Permit one delayed
// retry, then require the existing manual-resume path so recovery never burns
// requests in a hot loop. The queued job and transcript are retained.
const QUOTA_EXHAUSTED_RETRY_DELAY_MS = 24 * 60 * 60_000;
const MAX_QUOTA_EXHAUSTED_ATTEMPTS = 2;

export class RecoveryConsumer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private activeJobId: number | null = null;
  private activeTick: Promise<void> | null = null;
  private processed = 0;
  private readonly owner = `recovery-${process.pid}-${randomUUID()}`;
  constructor(private readonly dbManager: DatabaseManager, private readonly provider: Pick<NvidiaProvider, 'generateRecoverySummary'>, private readonly intervalMs = 5000) {}

  start(): void { if (!this.stopped) return; this.stopped = false; this.schedule(0); }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.activeTick) await this.activeTick;
  }
  status(): RecoveryConsumerStatus { return { running: !this.stopped, activeJobId: this.activeJobId, processed: this.processed }; }
  private schedule(delay: number): void {
    if (!this.stopped) this.timer = setTimeout(() => { this.activeTick = this.runTick().finally(() => { this.activeTick = null; }); }, delay);
  }
  async tick(force = false, recoveryKey?: string): Promise<void> {
    if (this.activeTick) return this.activeTick;
    this.activeTick = this.runTick(force, recoveryKey).finally(() => { this.activeTick = null; });
    return this.activeTick;
  }
  private dead(job: RecoveryJobRecord, reason: string): void {
    this.dbManager.getSessionStore().markRecoveryJobDeadLetter(job.id, reason, Date.now(), this.owner);
  }
  private owns(jobId: number): boolean {
    const current = this.dbManager.getSessionStore().getRecoveryJob(jobId);
    return current?.status === 'running' && current.lease_owner === this.owner;
  }
  private async runTick(force = false, recoveryKey?: string): Promise<void> {
    if ((!force && this.stopped) || this.activeJobId !== null) return;
    const jobs = new RecoveryJobService(this.dbManager.getSessionStore());
    const job = recoveryKey ? jobs.claimByKey(recoveryKey, this.owner, LEASE_MS) : jobs.claimOldest(this.owner, LEASE_MS);
    if (!job) { this.schedule(this.intervalMs); return; }
    this.activeJobId = job.id;
    this.heartbeat = setInterval(() => {
      if (!jobs.renewLease(job.id, this.owner, LEASE_MS)) logger.warn('SESSION', 'Recovery lease heartbeat lost ownership', { recoveryJobId: job.id });
    }, HEARTBEAT_MS);
    try {
      if (job.platform_source !== 'codex') { this.dead(job, `unsupported_platform:${job.platform_source}`); return; }
      if (!job.transcript_locator || !existsSync(job.transcript_locator)) { jobs.deadLetterMissingTranscript(job.id, job.transcript_locator, Date.now(), this.owner); return; }
      const transcript = parseCodexTranscript(job.transcript_locator);
      if (job.content_session_id !== transcript.lineage.contentSessionId ||
          job.parent_content_session_id !== transcript.lineage.parentContentSessionId ||
          job.root_content_session_id !== transcript.lineage.rootContentSessionId) {
        this.dead(job, 'lineage_mismatch: job and canonical transcript differ'); return;
      }
      const turn = transcript.turns.find(item => item.sourceFingerprint === job.source_fingerprint);
      if (!turn || turn.turnId !== job.turn_id || turn.promptNumber !== job.prompt_number) {
        this.dead(job, 'turn_mismatch: exact fingerprint, turn id and prompt number required'); return;
      }
      if (!turn.finalAssistantMessage && turn.toolEvidence.length === 0) { this.dead(job, 'insufficient_evidence'); return; }
      const store = this.dbManager.getSessionStore();
      let project = job.project;
      if (transcript.lineage.parentContentSessionId) {
        const parent = store.db.prepare('SELECT project FROM sdk_sessions WHERE platform_source=? AND content_session_id=? LIMIT 1').get('codex', transcript.lineage.parentContentSessionId) as { project: string } | null;
        if (!parent) { this.dead(job, 'missing_parent_lineage'); return; }
        project = parent.project;
      }
      if (!project || ['recovery', 'tmp'].includes(project)) { this.dead(job, 'invalid_project_lineage'); return; }
      if (!this.owns(job.id)) return;

      const existing = store.getRecoverySummaryByFingerprint(turn.sourceFingerprint);
      if (existing) {
        const chroma = this.dbManager.getChromaSync();
        if (chroma) {
          const result = await chroma.syncSummary(existing.id, existing.memory_session_id, existing.project, existing, existing.prompt_number ?? 0, existing.created_at_epoch, 'codex');
          if (!result?.complete || result.written !== result.expected) throw new Error(`chroma_partial:${result?.written ?? 0}/${result?.expected ?? 0}`);
        } else logger.warn('CHROMA_SYNC', 'Recovery completed under explicit sqlite_only policy', { recoveryJobId: job.id });
        if (!this.owns(job.id) || !jobs.complete(job.id, this.owner)) return;
        this.processed += 1;
        return;
      }

      const session = store.upsertSessionLineage(transcript.lineage.contentSessionId, project, 'codex', {
        parentContentSessionId: transcript.lineage.parentContentSessionId, rootContentSessionId: transcript.lineage.rootContentSessionId,
        agentId: transcript.lineage.agentId, agentType: transcript.lineage.agentType, agentPath: transcript.lineage.agentPath,
        agentNickname: transcript.lineage.agentNickname, agentDepth: transcript.lineage.agentDepth, transcriptLocator: transcript.locator,
      }, turn.occurredAtEpoch);
      if (!this.owns(job.id)) return;
      const summary = await this.provider.generateRecoverySummary(turn);
      if (!this.owns(job.id)) return;
      const stored = store.storeRecoverySummary(session.memory_session_id, project, summary, turn.sourceFingerprint, turn.promptNumber, turn.occurredAtEpoch);
      const chroma = this.dbManager.getChromaSync();
      if (chroma) {
        const result = await chroma.syncSummary(stored.id, session.memory_session_id, project, summary, turn.promptNumber, stored.createdAtEpoch, 'codex');
        if (!result?.complete || result.written !== result.expected) throw new Error(`chroma_partial:${result?.written ?? 0}/${result?.expected ?? 0}`);
      } else logger.warn('CHROMA_SYNC', 'Recovery completed under explicit sqlite_only policy', { recoveryJobId: job.id });
      if (!this.owns(job.id) || !jobs.complete(job.id, this.owner)) return;
      this.processed += 1;
      logger.info('SESSION', 'Recovery job completed', { recoveryJobId: job.id, contentSessionId: transcript.lineage.contentSessionId, project });
    } catch (error) {
      if (!this.owns(job.id)) return;
      const kind = isClassified(error) ? error.kind : 'transient';
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      if (kind === 'unrecoverable') this.dead(job, `malformed_or_unrecoverable:${message}`);
      else if (kind === 'auth_invalid') {
        if (job.attempts >= MAX_AUTH_ATTEMPTS) this.dead(job, `blocked_auth_manual_resume:${message}`);
        else jobs.retryLater(job.id, this.owner, Date.now() + 15 * 60_000, `blocked_auth:${message}`);
      } else if (kind === 'rate_limit') {
        if (job.attempts >= MAX_QUOTA_ATTEMPTS) this.dead(job, `blocked_quota_manual_resume:${message}`);
        else jobs.retryLater(job.id, this.owner, Date.now() + (isClassified(error) ? error.retryAfterMs ?? 60_000 : 60_000), `blocked_quota:${message}`);
      } else if (kind === 'quota_exhausted') {
        if (job.attempts >= MAX_QUOTA_EXHAUSTED_ATTEMPTS) this.dead(job, `blocked_quota_exhausted_manual_resume:${message}`);
        else jobs.retryLater(job.id, this.owner, Date.now() + Math.max(QUOTA_EXHAUSTED_RETRY_DELAY_MS, isClassified(error) ? error.retryAfterMs ?? 0 : 0), `blocked_quota_exhausted:${message}`);
      } else if (job.attempts >= MAX_TRANSIENT_ATTEMPTS) this.dead(job, `retry_exhausted_manual_resume:${message}`);
      else jobs.retryLater(job.id, this.owner, Date.now() + Math.min(60 * 60_000, 5_000 * 2 ** Math.min(job.attempts, 8)), message);
    } finally {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.activeJobId = null;
      if (!this.stopped) this.schedule(this.intervalMs);
    }
  }
}
