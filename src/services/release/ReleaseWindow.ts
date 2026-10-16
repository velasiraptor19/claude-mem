import { randomUUID } from 'crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { resolveDataDir } from '../../shared/paths.js';
import type { SessionStore } from '../sqlite/SessionStore.js';

export type ReleaseWindowPhase =
  | 'prepared' | 'hooks_detached' | 'hooks_drained' | 'worker_quiesced' | 'snapshot_ready'
  | 'artifact_installed' | 'worker_attested' | 'hooks_attached' | 'window_closed'
  | 'recovery_reconciled' | 'rolling_back' | 'failed';

const TERMINAL = new Set<ReleaseWindowPhase>(['recovery_reconciled', 'failed']);
const NEXT: Partial<Record<ReleaseWindowPhase, ReleaseWindowPhase>> = {
  prepared: 'hooks_detached', hooks_detached: 'hooks_drained', hooks_drained: 'worker_quiesced', worker_quiesced: 'snapshot_ready',
  snapshot_ready: 'artifact_installed', artifact_installed: 'worker_attested', worker_attested: 'hooks_attached',
  hooks_attached: 'window_closed', window_closed: 'recovery_reconciled',
};
const PHASES = new Set<ReleaseWindowPhase>([
  'prepared', 'hooks_detached', 'hooks_drained', 'worker_quiesced', 'snapshot_ready',
  'artifact_installed', 'worker_attested', 'hooks_attached', 'window_closed',
  'recovery_reconciled', 'rolling_back', 'failed',
]);

export interface ReleaseWindowV1 {
  schemaVersion: 1;
  id: string;
  generation: number;
  phase: ReleaseWindowPhase;
  startedAt: string;
  updatedAt: string;
  hooksDetachedAt?: string;
  hookDrainAcknowledged: boolean;
  oldArtifactSha256: string | null;
  newArtifactSha256: string | null;
  recoveryBounds: { startedAt: string; endedAt?: string };
  rollbackReceipt?: string;
  managedStartAuthorization?: { generation: number; token: string; issuedAt: string; consumed: boolean };
}

interface CanonicalRecoveryReceiptV1 {
  schemaVersion: 1;
  generation: number;
  windowId: string;
  recoveryBounds: { startedAt: string; endedAt: string };
  workerPid: number;
  completedAt: string;
  candidateKeys: string[];
}

export interface CanonicalRecoveryCandidateV1 {
  recoveryKey: string;
  sourceFingerprint: string;
  disposition: 'job' | 'safe_dedup' | 'unresolved';
}

interface CanonicalRecoveryPlanV1 {
  schemaVersion: 1;
  generation: number;
  windowId: string;
  recoveryBounds: { startedAt: string; endedAt: string };
  candidates: CanonicalRecoveryCandidateV1[];
  createdAt: string;
}

const MAX_CANONICAL_RECOVERY_CANDIDATES = 10_000;

function filePath(dataDir: string): string { return join(dataDir, 'release-window-v1.json'); }
function recoveryReceiptPath(dataDir: string): string { return join(dataDir, 'canonical-recovery-receipt-v1.json'); }
function recoveryPlanPath(dataDir: string): string { return join(dataDir, 'canonical-recovery-plan-v1.json'); }
function leasesPath(dataDir: string): string { return join(dataDir, 'release-hook-leases-v1'); }

function isReleaseWindow(value: unknown): value is ReleaseWindowV1 {
  if (!value || typeof value !== 'object') return false;
  const window = value as Partial<ReleaseWindowV1>;
  const grant = window.managedStartAuthorization;
  return window.schemaVersion === 1
    && typeof window.id === 'string' && window.id.length > 0
    && typeof window.generation === 'number' && Number.isSafeInteger(window.generation) && window.generation > 0
    && typeof window.phase === 'string' && PHASES.has(window.phase as ReleaseWindowPhase)
    && typeof window.startedAt === 'string' && typeof window.updatedAt === 'string'
    && (window.hooksDetachedAt === undefined || typeof window.hooksDetachedAt === 'string')
    && typeof window.hookDrainAcknowledged === 'boolean'
    && (typeof window.oldArtifactSha256 === 'string' || window.oldArtifactSha256 === null)
    && (typeof window.newArtifactSha256 === 'string' || window.newArtifactSha256 === null)
    && !!window.recoveryBounds && typeof window.recoveryBounds.startedAt === 'string'
    && (grant === undefined || (
      typeof grant === 'object' && grant !== null
      && grant.generation === window.generation
      && typeof grant.token === 'string' && /^[a-f0-9]{64}$/i.test(grant.token)
      && typeof grant.issuedAt === 'string' && typeof grant.consumed === 'boolean'
    ));
}

function read(dataDir: string): ReleaseWindowV1 | null {
  const stateFile = filePath(dataDir);
  if (!existsSync(stateFile)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { throw new Error('Release window state is unreadable; refusing to bypass maintenance fence'); }
  if (!isReleaseWindow(parsed)) throw new Error('Release window state is invalid; refusing to bypass maintenance fence');
  return parsed;
}

export class ReleaseWindowManager {
  constructor(private readonly dataDir = resolveDataDir()) {}
  current(): ReleaseWindowV1 | null { return read(this.dataDir); }
  isMaintenanceActive(): boolean {
    try { const current = this.current(); return current !== null && !TERMINAL.has(current.phase); } catch { return true; }
  }
  private withMutationLock<T>(operation: () => T): T {
    const lock = `${filePath(this.dataDir)}.mutation-lock`;
    mkdirSync(this.dataDir, { recursive: true });
    const startToken = (pid: number): string | null => { try { const value=readFileSync(`/proc/${pid}/stat`,'utf8'); return value.slice(value.lastIndexOf(')')+2).split(' ')[19] || null; } catch { return null; } };
    const owner = { pid: process.pid, startToken: startToken(process.pid), nonce: randomUUID() };
    const ownerFile = join(lock, 'owner.json');
    let acquired = false;
    for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
      const prepared = `${lock}.prepared.${owner.nonce}`;
      try {
        mkdirSync(prepared, { mode: 0o700 });
        const fd=openSync(join(prepared, 'owner.json'),'wx',0o600); try { writeFileSync(fd, JSON.stringify(owner)); } finally { closeSync(fd); }
        symlinkSync(prepared, lock); acquired=true;
      }
      catch (error) {
        try { rmSync(prepared, { recursive: true, force: true }); } catch {}
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let prior: {pid:number;startToken:string|null;nonce:string};
        try { prior=JSON.parse(readFileSync(ownerFile,'utf8')) as typeof prior; } catch { throw new Error('Release state mutation lock is incomplete; refusing unsafe recovery'); }
        if (!/^[a-f0-9-]{32,64}$/i.test(prior.nonce) || readlinkSync(lock) !== `${lock}.prepared.${prior.nonce}`) throw new Error('Release state mutation lock ownership is invalid; refusing unsafe recovery');
        const live=startToken(prior.pid);
        let held=prior.pid>1&&live!==null&&live===prior.startToken;
        if (prior.pid > 1 && live === null) {
          try { process.kill(prior.pid, 0); held=true; }
          catch (probeError) { held=(probeError as NodeJS.ErrnoException).code !== 'ESRCH'; }
        }
        if (held) throw new Error('Release state mutation already in progress');
        const quarantine = `${lock}.stale.${prior.nonce}.${owner.nonce}`;
        try { renameSync(lock, quarantine); } catch (renameError) { if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError; }
        try { const target=readlinkSync(quarantine); unlinkSync(quarantine); rmSync(target, { recursive: true, force: true }); } catch {}
      }
    }
    if (!acquired) throw new Error('Release state mutation already in progress');
    try { return operation(); } finally {
      try {
        const current=JSON.parse(readFileSync(ownerFile,'utf8')) as {nonce?:string};
        if(current.nonce===owner.nonce) { const released=`${lock}.released.${owner.nonce}`; renameSync(lock,released); unlinkSync(released); rmSync(`${lock}.prepared.${owner.nonce}`,{recursive:true,force:true}); }
      } catch { /* do not mask the state transition */ }
    }
  }
  begin(oldArtifactSha256: string | null): ReleaseWindowV1 {
    return this.withMutationLock(() => {
      const previous = this.current();
      if (previous && !TERMINAL.has(previous.phase)) throw new Error(`Release window ${previous.id} is still active at ${previous.phase}`);
      const now = new Date().toISOString();
      const window: ReleaseWindowV1 = { schemaVersion: 1, id: randomUUID(), generation: (previous?.generation ?? 0) + 1, phase: 'prepared', startedAt: now, updatedAt: now, hookDrainAcknowledged: false, oldArtifactSha256, newArtifactSha256: null, recoveryBounds: { startedAt: now } };
      writeJsonFileAtomic(filePath(this.dataDir), window);
      return window;
    });
  }
  transition(generation: number, phase: ReleaseWindowPhase, patch: Partial<ReleaseWindowV1> = {}): ReleaseWindowV1 {
    return this.withMutationLock(() => {
      const current = this.current();
      if (!current || current.generation !== generation) throw new Error('Release generation fence rejected transition');
      if (TERMINAL.has(current.phase)) throw new Error(`Cannot transition terminal release window ${current.phase}`);
      if (phase === 'rolling_back' && current.phase === 'rolling_back') throw new Error('Rollback is already active');
      if (phase === 'failed' && current.phase !== 'rolling_back') throw new Error('Failure is only valid after rollback');
      if (phase === 'recovery_reconciled') throw new Error('Only the restarted worker may record canonical recovery completion');
      if (phase !== 'rolling_back' && phase !== 'failed' && NEXT[current.phase] !== phase) throw new Error(`Invalid release transition ${current.phase} -> ${phase}`);
      for (const field of ['schemaVersion', 'id', 'generation', 'phase', 'startedAt', 'updatedAt'] as const) {
        if (field in patch && patch[field] !== current[field]) throw new Error(`Release transition cannot overwrite ${field}`);
      }
      if (phase === 'worker_quiesced' && !current.hookDrainAcknowledged && patch.hookDrainAcknowledged !== true) throw new Error('Cannot quiesce worker before hook drain acknowledgement');
      const next = { ...current, ...patch, phase, updatedAt: new Date().toISOString() } as ReleaseWindowV1;
      if (phase === 'hooks_detached') next.hooksDetachedAt = next.updatedAt;
      if (phase === 'window_closed') next.recoveryBounds = { ...next.recoveryBounds, endedAt: next.updatedAt };
      writeJsonFileAtomic(filePath(this.dataDir), next);
      return next;
    });
  }
  /**
   * The restarted root worker owns the final release fence.  Its receipt is
   * generation-, window- and interval-bound, so a stale worker (or a receipt
   * copied from another release) cannot reopen hooks.  Writing the receipt
   * first makes an interrupted final transition idempotently resumable.
   */
  canonicalRecoveryPlan(generation: number): CanonicalRecoveryPlanV1 | null {
    const current = this.current();
    if (!current || current.generation !== generation || current.phase !== 'window_closed') throw new Error('Canonical recovery plan requires the matching closed release window');
    const planFile = recoveryPlanPath(this.dataDir);
    if (!existsSync(planFile)) return null;
    let plan: unknown;
    try { plan = JSON.parse(readFileSync(planFile, 'utf8')); } catch { throw new Error('Canonical recovery plan is unreadable'); }
    const value = plan as Partial<CanonicalRecoveryPlanV1>;
    const endedAt = current.recoveryBounds.endedAt;
    if (!endedAt || value.schemaVersion !== 1 || value.generation !== current.generation || value.windowId !== current.id
      || value.recoveryBounds?.startedAt !== current.recoveryBounds.startedAt || value.recoveryBounds?.endedAt !== endedAt
      || !Array.isArray(value.candidates) || value.candidates.length > MAX_CANONICAL_RECOVERY_CANDIDATES
      || value.candidates.some(candidate => !candidate || typeof candidate.recoveryKey !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.recoveryKey)
        || typeof candidate.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.sourceFingerprint)
        || !['job', 'safe_dedup', 'unresolved'].includes(candidate.disposition as string))) {
      throw new Error('Canonical recovery plan is stale, mismatched, or invalid');
    }
    return value as CanonicalRecoveryPlanV1;
  }
  persistCanonicalRecoveryPlan(generation: number, candidates: CanonicalRecoveryCandidateV1[]): CanonicalRecoveryPlanV1 {
    return this.withMutationLock(() => {
      const existing = this.canonicalRecoveryPlan(generation);
      if (existing) return existing;
      const current = this.current();
      const endedAt = current?.recoveryBounds.endedAt;
      if (!current || current.generation !== generation || current.phase !== 'window_closed' || !endedAt) throw new Error('Canonical recovery plan requires the matching closed release window');
      if (!Array.isArray(candidates) || candidates.length > MAX_CANONICAL_RECOVERY_CANDIDATES
        || candidates.some(candidate => !candidate || typeof candidate.recoveryKey !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.recoveryKey)
          || typeof candidate.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.sourceFingerprint)
          || !['job', 'safe_dedup', 'unresolved'].includes(candidate.disposition))) throw new Error('Canonical recovery candidate set is invalid or exceeds its finite limit');
      const keys = new Set<string>();
      if (candidates.some(candidate => keys.has(candidate.recoveryKey) || !keys.add(candidate.recoveryKey))) throw new Error('Canonical recovery candidate set contains duplicate keys');
      const plan: CanonicalRecoveryPlanV1 = { schemaVersion: 1, generation: current.generation, windowId: current.id,
        recoveryBounds: { startedAt: current.recoveryBounds.startedAt, endedAt }, candidates, createdAt: new Date().toISOString() };
      writeJsonFileAtomic(recoveryPlanPath(this.dataDir), plan);
      return plan;
    });
  }
  recordCanonicalRecoveryCompletion(generation: number, store: SessionStore): ReleaseWindowV1 {
    return this.withMutationLock(() => {
      const current = this.current();
      if (!current || current.generation !== generation || current.phase !== 'window_closed') {
        throw new Error('Canonical recovery completion requires the matching closed release window');
      }
      const endedAt = current.recoveryBounds.endedAt;
      if (!endedAt) throw new Error('Closed release window is missing recovery interval end');
      const plan = this.canonicalRecoveryPlan(generation);
      if (!plan) throw new Error('Canonical recovery candidate plan is missing');
      for (const candidate of plan.candidates) {
        if (candidate.disposition === 'unresolved') throw new Error(`Canonical recovery candidate remains unresolved: ${candidate.recoveryKey}`);
        if (candidate.disposition === 'safe_dedup') {
          const historical = store.db.prepare('SELECT 1 FROM historical_summary_representations WHERE source_fingerprint=? LIMIT 1').get(candidate.sourceFingerprint);
          if (!store.hasSummaryFingerprint(candidate.sourceFingerprint) && !historical) {
            throw new Error(`Canonical recovery dedup proof no longer exists: ${candidate.recoveryKey}`);
          }
        }
        if (candidate.disposition === 'job') {
          const job = store.getRecoveryJobByKey(candidate.recoveryKey);
          if (job?.status !== 'completed' || !store.hasSummaryFingerprint(candidate.sourceFingerprint)) {
            throw new Error(`Canonical recovery job is not terminally successful: ${candidate.recoveryKey}`);
          }
        }
      }
      const expected = { generation: current.generation, windowId: current.id, recoveryBounds: { startedAt: current.recoveryBounds.startedAt, endedAt } };
      const receiptFile = recoveryReceiptPath(this.dataDir);
      if (existsSync(receiptFile)) {
        let existing: unknown;
        try { existing = JSON.parse(readFileSync(receiptFile, 'utf8')); } catch { throw new Error('Canonical recovery receipt is unreadable'); }
        const receipt = existing as Partial<CanonicalRecoveryReceiptV1>;
        if (receipt.schemaVersion !== 1 || receipt.generation !== expected.generation || receipt.windowId !== expected.windowId
          || receipt.recoveryBounds?.startedAt !== expected.recoveryBounds.startedAt || receipt.recoveryBounds?.endedAt !== expected.recoveryBounds.endedAt
          || !Number.isSafeInteger(receipt.workerPid) || receipt.workerPid! < 2 || typeof receipt.completedAt !== 'string'
          || !Array.isArray(receipt.candidateKeys) || JSON.stringify(receipt.candidateKeys) !== JSON.stringify(plan.candidates.map(candidate => candidate.recoveryKey))) {
          throw new Error('Canonical recovery receipt is stale, mismatched, or invalid');
        }
      } else {
        const receipt: CanonicalRecoveryReceiptV1 = { schemaVersion: 1, ...expected, workerPid: process.pid, completedAt: new Date().toISOString(), candidateKeys: plan.candidates.map(candidate => candidate.recoveryKey) };
        writeJsonFileAtomic(receiptFile, receipt);
      }
      return this.transitionUnlocked(current, 'recovery_reconciled', {});
    });
  }
  acknowledgeHookDrain(generation: number): ReleaseWindowV1 { return this.transition(generation, 'hooks_drained', { hookDrainAcknowledged: true }); }
  markWorkerQuiesced(generation: number): ReleaseWindowV1 { return this.transition(generation, 'worker_quiesced'); }
  issueManagedStartAuthorization(generation: number): { generation: number; token: string } {
    return this.withMutationLock(() => {
      const current = this.current();
      if (!current || current.generation !== generation) throw new Error('Release generation fence rejected start authorization');
      if (!['artifact_installed', 'window_closed', 'rolling_back'].includes(current.phase)) throw new Error(`Cannot authorize start at ${current.phase}`);
      if (current.managedStartAuthorization && !current.managedStartAuthorization.consumed) throw new Error('Managed start authorization is already outstanding');
      const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
      const next: ReleaseWindowV1 = {
        ...current,
        updatedAt: new Date().toISOString(),
        managedStartAuthorization: { generation: current.generation, token, issuedAt: new Date().toISOString(), consumed: false },
      };
      writeJsonFileAtomic(filePath(this.dataDir), next);
      return { generation: current.generation, token };
    });
  }
  /** Consume the installer-only, generation-bound start grant.  The mkdir lock
   * makes two concurrent hook/installer callers unable to redeem one token. */
  consumeManagedStartAuthorization(token: string | undefined): boolean {
    if (!token) return false;
    try { return this.withMutationLock(() => {
      const current = this.current();
      const grant = current?.managedStartAuthorization;
      if (!current || !grant || grant.consumed || grant.generation !== current.generation || grant.token !== token || !['artifact_installed', 'window_closed', 'rolling_back'].includes(current.phase)) return false;
      const next = { ...current, managedStartAuthorization: { ...grant, consumed: true }, updatedAt: new Date().toISOString() };
      writeJsonFileAtomic(filePath(this.dataDir), next);
      return true;
    }); } catch { return false; }
  }
  canRequestWorkerStart(token?: string): boolean {
    if (!this.isMaintenanceActive()) return true;
    const current = this.current();
    const grant = current?.managedStartAuthorization;
    return Boolean(current && grant && !grant.consumed && grant.generation === current.generation
      && token === grant.token && ['artifact_installed', 'window_closed', 'rolling_back'].includes(current.phase));
  }
  canStartWorker(managedStartAuthorization?: string): boolean {
    if (!this.isMaintenanceActive()) return true;
    return this.consumeManagedStartAuthorization(managedStartAuthorization);
  }

  /**
   * A hook lease is acquired under the same mutation lock as detachment.  This
   * closes the race where a hook read "not detached" just before the installer
   * persisted hooks_detached, then began work after the installer self-acked a
   * drain.  Lease files deliberately contain only the release generation and
   * PID: they are an auditable, crash-safe drain barrier, not a liveness oracle.
   */
  tryAcquireHookLease(): (() => void) | null {
    let lease: string | null = null;
    try {
      this.withMutationLock(() => {
        if (this.isMaintenanceActive()) return;
        const directory = leasesPath(this.dataDir);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        lease = join(directory, `${process.pid}-${randomUUID()}.json`);
        const startToken = (() => { try { const value=readFileSync(`/proc/${process.pid}/stat`,'utf8'); return value.slice(value.lastIndexOf(')')+2).split(' ')[19] || undefined; } catch { return undefined; } })();
        writeFileSync(lease, JSON.stringify({ schemaVersion: 1, pid: process.pid, startToken, acquiredAt: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'wx' });
      });
    } catch {
      return null;
    }
    if (!lease) return null;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { unlinkSync(lease!); } catch { /* process exit leaves evidence; installer fails closed */ }
    };
  }

  activeHookLeaseCount(): number {
    const directory = leasesPath(this.dataDir);
    if (!existsSync(directory)) return 0;
    try { return readdirSync(directory).filter(name => name.endsWith('.json')).length; } catch { return Number.POSITIVE_INFINITY; }
  }

  acknowledgeHookDrainAfterLeases(generation: number): ReleaseWindowV1 {
    return this.withMutationLock(() => {
      const current = this.current();
      if (!current || current.generation !== generation) throw new Error('Release generation fence rejected hook drain');
      if (current.phase !== 'hooks_detached') throw new Error(`Invalid release transition ${current.phase} -> hooks_drained`);
      if (this.activeHookLeaseCount() !== 0) throw new Error('Cannot acknowledge hook drain while hook leases remain');
      return this.transitionUnlocked(current, 'hooks_drained', { hookDrainAcknowledged: true });
    });
  }

  private transitionUnlocked(current: ReleaseWindowV1, phase: ReleaseWindowPhase, patch: Partial<ReleaseWindowV1>): ReleaseWindowV1 {
    const next = { ...current, ...patch, phase, updatedAt: new Date().toISOString() } as ReleaseWindowV1;
    if (phase === 'window_closed') next.recoveryBounds = { ...next.recoveryBounds, endedAt: next.updatedAt };
    writeJsonFileAtomic(filePath(this.dataDir), next);
    return next;
  }
}
