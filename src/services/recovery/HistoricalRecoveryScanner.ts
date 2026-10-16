import { lstat, readdir, realpath } from 'fs/promises';
import { homedir } from 'os';
import { basename, join, relative, resolve, sep } from 'path';
import { getProjectContext } from '../../utils/project-name.js';
import { isAutoRevivableRecoveryCancellation } from '../../types/database.js';
import type { SessionStore } from '../sqlite/SessionStore.js';
import { RecoveryJobService } from './RecoveryJobService.js';
import { parseCodexTranscriptAsync, recoveryKeyFor, type ParsedCodexTranscript } from './CodexTranscriptRecovery.js';

export type RecoveryScanCandidate = {
  recoveryKey: string;
  sourceFingerprint: string;
  disposition: 'job' | 'safe_dedup' | 'unresolved';
};
export interface RecoveryScanBounds { startedAt: string; endedAt: string; }
export interface RecoveryScanReport { files: number; validTranscripts: number; unstableTranscripts: number; eligible: number; enqueued: number; alreadyRepresented: number; truncated: boolean; deadLetterCandidates: Array<{ locator: string; reason: string }>; candidates: RecoveryScanCandidate[]; }
export interface RecoveryScanLimits { maxFiles: number; maxFileBytes: number; maxDurationMs: number; }
const DEFAULT_LIMITS: RecoveryScanLimits = { maxFiles: 10_000, maxFileBytes: 64 * 1024 * 1024, maxDurationMs: 120_000 };

export function configuredCodexTranscriptRoot(): string { return resolve(homedir(), '.codex', 'sessions'); }

async function jsonlFiles(root: string, limits: RecoveryScanLimits): Promise<{ files: string[]; truncated: boolean }> {
  const allowed = await realpath(root);
  const out: string[] = [];
  const started = Date.now();
  let truncated = false;
  const visit = async (path: string): Promise<void> => {
    if (out.length >= limits.maxFiles || Date.now() - started >= limits.maxDurationMs) { truncated = true; return; }
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return;
    const actual = await realpath(path);
    if (actual !== allowed && !actual.startsWith(`${allowed}${sep}`)) return;
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (path.endsWith('.jsonl')) {
      // The release scan is a completeness proof.  Do not silently omit a
      // canonical transcript merely because normal-history limits reject it.
      if (stat.size > limits.maxFileBytes) truncated = true;
      else out.push(path);
    }
  };
  await visit(allowed);
  return { files: out, truncated };
}

export class HistoricalRecoveryScanner {
  constructor(private readonly store: SessionStore, private readonly limits: RecoveryScanLimits = DEFAULT_LIMITS, private readonly rootOverride?: string, private readonly minStableAgeMs = 0) {}
  async scan(dryRun = false, maxEnqueue = Number.POSITIVE_INFINITY, bounds?: RecoveryScanBounds): Promise<RecoveryScanReport> {
    if (!(maxEnqueue === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxEnqueue) && maxEnqueue > 0))) throw new Error('invalid_max_enqueue');
    const lower = bounds ? Date.parse(bounds.startedAt) : Number.NEGATIVE_INFINITY;
    const upper = bounds ? Date.parse(bounds.endedAt) : Number.POSITIVE_INFINITY;
    if (bounds && (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper)) throw new Error('invalid_recovery_bounds');
    const root = await realpath(this.rootOverride ?? configuredCodexTranscriptRoot());
    const discovered = await jsonlFiles(root, this.limits);
    const report: RecoveryScanReport = { files: 0, validTranscripts: 0, unstableTranscripts: 0, eligible: 0, enqueued: 0, alreadyRepresented: 0, truncated: discovered.truncated, deadLetterCandidates: [], candidates: [] };
    const parsed: ParsedCodexTranscript[] = [];
    for (const locator of discovered.files) {
      report.files += 1;
      try {
        if (this.minStableAgeMs > 0 && Date.now() - (await lstat(locator)).mtimeMs < this.minStableAgeMs) {
          report.unstableTranscripts += 1;
          continue;
        }
        const transcript = await parseCodexTranscriptAsync(locator);
        parsed.push(transcript);
        report.validTranscripts += 1;
        for (const corruption of transcript.corruptions) report.deadLetterCandidates.push({
          locator: relative(root, transcript.locator),
          reason: `corrupt_turn:line=${corruption.line}:turn=${corruption.turnId ?? 'unknown'}`,
        });
      }
      catch (error) { report.deadLetterCandidates.push({ locator: basename(locator), reason: error instanceof Error ? error.message : String(error) }); }
      await Promise.resolve();
    }
    const byId = new Map(parsed.map(transcript => [transcript.lineage.contentSessionId, transcript]));
    const known = new Map<string, string>();
    const resolving = new Set<string>();
    const resolveProject = (transcript: ParsedCodexTranscript): string => {
      const id = transcript.lineage.contentSessionId;
      const cached = known.get(id);
      if (cached !== undefined) return cached;
      if (resolving.has(id)) return '';
      resolving.add(id);
      let project = '';
      const parentId = transcript.lineage.parentContentSessionId;
      if (parentId) {
        const parentTranscript = byId.get(parentId);
        project = parentTranscript ? resolveProject(parentTranscript) :
          ((this.store.db.prepare('SELECT project FROM sdk_sessions WHERE platform_source=? AND content_session_id=? LIMIT 1').get('codex', parentId) as { project: string } | null)?.project ?? '');
      } else {
        project = ((this.store.db.prepare('SELECT project FROM sdk_sessions WHERE platform_source=? AND content_session_id=? LIMIT 1').get('codex', id) as { project: string } | null)?.project ?? '');
        if (!project && transcript.lineage.cwd) project = getProjectContext(transcript.lineage.cwd).primary;
      }
      resolving.delete(id);
      known.set(id, project);
      return project;
    };
    const candidates: Array<{ transcript: ParsedCodexTranscript; turn: ParsedCodexTranscript['turns'][number]; project: string }> = [];
    for (const transcript of parsed) {
      const project = resolveProject(transcript);
      if (!project && transcript.lineage.parentContentSessionId) { report.deadLetterCandidates.push({ locator: relative(root, transcript.locator), reason: 'missing_parent_lineage' }); continue; }
      if (!project || ['recovery', 'tmp'].includes(project)) { report.deadLetterCandidates.push({ locator: relative(root, transcript.locator), reason: 'invalid_project_lineage' }); continue; }
      for (const turn of transcript.turns) {
        // A release recovery is an interval proof, not a best-effort history
        // sweep.  Only canonical turn content whose own timestamp lies inside
        // the persisted closed window may become part of its durable plan.
        if (!turn.hasAuthoritativeTimestamp) {
          // An unknown timestamp cannot be proven outside this exact window.
          // Treat it as an incomplete discovery, never as epoch zero.
          if (bounds) {
            report.truncated = true;
            report.deadLetterCandidates.push({ locator: relative(root, transcript.locator), reason: `invalid_authoritative_timestamp:turn=${turn.turnId}` });
            continue;
          }
          // Legacy best-effort history recovery keeps its old epoch-zero
          // ordering.  Only a bounded release proof requires a timestamp.
          candidates.push({ transcript, turn, project });
          continue;
        }
        if (turn.occurredAtEpoch >= lower && turn.occurredAtEpoch <= upper) candidates.push({ transcript, turn, project });
      }
    }
    candidates.sort((a, b) => (a.turn.occurredAtEpoch || Number.MAX_SAFE_INTEGER) - (b.turn.occurredAtEpoch || Number.MAX_SAFE_INTEGER)
      || a.transcript.lineage.agentDepth - b.transcript.lineage.agentDepth
      || a.transcript.locator.localeCompare(b.transcript.locator)
      || a.turn.promptNumber - b.turn.promptNumber);
    for (const { transcript, turn, project } of candidates) {
      const key = recoveryKeyFor(transcript, turn);
      const reconciled = this.store.db.prepare('SELECT 1 FROM historical_summary_representations WHERE source_fingerprint=? LIMIT 1').get(turn.sourceFingerprint);
      const existingJob = this.store.getRecoveryJobByKey(key);
      const safelyRepresented = this.store.hasSummaryFingerprint(turn.sourceFingerprint) || Boolean(reconciled);
      if (safelyRepresented) {
        if (!dryRun) this.store.cancelSupersededTurnMismatchJobs('codex', transcript.lineage.contentSessionId, turn.promptNumber, turn.turnId, turn.sourceFingerprint);
        report.alreadyRepresented += 1;
        report.candidates.push({ recoveryKey: key, sourceFingerprint: turn.sourceFingerprint, disposition: 'safe_dedup' });
        continue;
      }
      // A crash may happen after durable enqueue but before the release plan is
      // persisted.  Pending/retry exact-key jobs are actionable recovery work,
      // not unresolved evidence; bring a retry forward and retain its key.
      if (existingJob && (existingJob.status === 'pending' || existingJob.status === 'retry_wait')) {
        if (!dryRun) {
          new RecoveryJobService(this.store).enqueue({ contentSessionId: transcript.lineage.contentSessionId, recoveryKind: 'session_summary', project, platformSource: 'codex', transcriptLocator: transcript.locator, reason: 'historical_summary_gap', recoveryKey: key, sourceFingerprint: turn.sourceFingerprint, promptNumber: turn.promptNumber, turnId: turn.turnId, parentContentSessionId: transcript.lineage.parentContentSessionId, rootContentSessionId: transcript.lineage.rootContentSessionId, agentId: transcript.lineage.agentId, transcriptSha256: transcript.transcriptSha256 });
          this.store.cancelSupersededTurnMismatchJobs('codex', transcript.lineage.contentSessionId, turn.promptNumber, turn.turnId, turn.sourceFingerprint);
        }
        report.alreadyRepresented += 1;
        report.candidates.push({ recoveryKey: key, sourceFingerprint: turn.sourceFingerprint, disposition: 'job' });
        continue;
      }
      // A legacy/automatic cancellation is not evidence that this canonical turn
      // was summarized. Manual and unknown reasons are durable intent, and must
      // not be counted as a new enqueue candidate by a historical scan.
      const represented = existingJob && (existingJob.status !== 'cancelled'
          || !isAutoRevivableRecoveryCancellation(existingJob.cancellation_reason));
      if (represented) {
        if (!dryRun) this.store.cancelSupersededTurnMismatchJobs('codex', transcript.lineage.contentSessionId, turn.promptNumber, turn.turnId, turn.sourceFingerprint);
        report.alreadyRepresented += 1;
        report.candidates.push({ recoveryKey: key, sourceFingerprint: turn.sourceFingerprint,
          disposition: 'unresolved' });
        continue;
      }
      report.eligible += 1;
      if (dryRun) { report.enqueued += 1; report.candidates.push({ recoveryKey: key, sourceFingerprint: turn.sourceFingerprint, disposition: 'job' }); continue; }
      if (report.enqueued >= maxEnqueue) { report.candidates.push({ recoveryKey: key, sourceFingerprint: turn.sourceFingerprint, disposition: 'unresolved' }); continue; }
      new RecoveryJobService(this.store).enqueue({ contentSessionId: transcript.lineage.contentSessionId, recoveryKind: 'session_summary', project, platformSource: 'codex', transcriptLocator: transcript.locator, reason: 'historical_summary_gap', recoveryKey: key, sourceFingerprint: turn.sourceFingerprint, promptNumber: turn.promptNumber, turnId: turn.turnId, parentContentSessionId: transcript.lineage.parentContentSessionId, rootContentSessionId: transcript.lineage.rootContentSessionId, agentId: transcript.lineage.agentId, transcriptSha256: transcript.transcriptSha256 });
      this.store.cancelSupersededTurnMismatchJobs('codex', transcript.lineage.contentSessionId, turn.promptNumber, turn.turnId, turn.sourceFingerprint);
      report.enqueued += 1;
      report.candidates.push({ recoveryKey: key, sourceFingerprint: turn.sourceFingerprint, disposition: 'job' });
    }
    return report;
  }
}
