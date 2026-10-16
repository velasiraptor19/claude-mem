import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildReleaseIdentity,
  getOrCreateStoreInstallationId,
  readBuildAttestation,
  sqliteSchemaVersion,
  writeBuildAttestation,
} from '../../src/services/release/attestation.js';
import { ReleaseWindowManager } from '../../src/services/release/ReleaseWindow.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('attestation-first release identity', () => {
  let dataDir: string;

  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-attestation-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('persists one store UUID and binds a build record to a concrete bundle hash', () => {
    const bundle = join(dataDir, 'worker-service.cjs');
    const manifest = join(dataDir, 'plugin.json');
    writeFileSync(bundle, 'managed worker');
    writeFileSync(manifest, '{"version":"13.14.0"}');

    const storeId = getOrCreateStoreInstallationId(dataDir);
    expect(getOrCreateStoreInstallationId(dataDir)).toBe(storeId);

    const identity = buildReleaseIdentity({
      managedPluginVersion: '13.14.0', workerVersion: '13.14.0', workerBundlePath: bundle,
      manifestPath: manifest, workerEndpoint: '127.0.0.1:37777', workerHealth: 'healthy',
      workerPid: 42, hookWorkerPath: bundle, dataDir,
    });
    expect(identity.workerBundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.approvedManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.worker.hookTarget).toBe('managed');

    writeBuildAttestation({
      schemaVersion: 1, createdAt: new Date().toISOString(), sourceInputSha256: 'a'.repeat(64),
      outputBundleSha256: identity.workerBundleSha256!, manifestSha256: identity.approvedManifestSha256,
      sourceRevision: null, dirty: true, buildCommand: 'npm run build',
    }, dataDir);
    expect(readBuildAttestation(dataDir)?.outputBundleSha256).toBe(identity.workerBundleSha256);
  });

  it('reads SQLite user_version without opening the store', () => {
    const database = join(dataDir, 'claude-mem.db');
    const header = Buffer.alloc(100);
    header.write('SQLite format 3\0', 0, 'utf8');
    header.writeUInt32BE(42, 60);
    writeFileSync(database, header);
    expect(sqliteSchemaVersion(database)).toBe(42);
  });

  it('accepts separate client cache paths only when their worker bytes match', () => {
    const running = join(dataDir, 'codex-worker-service.cjs');
    const hook = join(dataDir, 'claude-worker-service.cjs');
    writeFileSync(running, 'same managed worker');
    writeFileSync(hook, 'same managed worker');
    const matching = buildReleaseIdentity({
      managedPluginVersion: '13.14.0', workerVersion: '13.14.0', workerBundlePath: running,
      manifestPath: null, workerEndpoint: '127.0.0.1:37700', workerHealth: 'healthy',
      workerPid: 42, hookWorkerPath: hook, dataDir,
    });
    expect(matching.worker.hookTarget).toBe('managed');
    writeFileSync(hook, 'legacy worker');
    const mismatching = buildReleaseIdentity({
      managedPluginVersion: '13.14.0', workerVersion: '13.14.0', workerBundlePath: running,
      manifestPath: null, workerEndpoint: '127.0.0.1:37700', workerHealth: 'healthy',
      workerPid: 42, hookWorkerPath: hook, dataDir,
    });
    expect(mismatching.worker.hookTarget).toBe('mismatch');
  });
});

describe('ReleaseWindowV1 generation fence', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-release-window-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('requires detach/drain before quiescence and blocks a second worker start', () => {
    const release = new ReleaseWindowManager(dataDir);
    const window = release.begin('a'.repeat(64));
    expect(release.canStartWorker()).toBe(false);
    expect(() => release.acknowledgeHookDrain(window.generation)).toThrow('Invalid release transition');

    release.transition(window.generation, 'hooks_detached');
    const drained = release.acknowledgeHookDrain(window.generation);
    expect(drained.phase).toBe('hooks_drained');
    expect(drained.hookDrainAcknowledged).toBe(true);
    const quiesced = release.markWorkerQuiesced(window.generation);
    expect(quiesced.phase).toBe('worker_quiesced');
    expect(() => release.transition(window.generation + 1, 'snapshot_ready')).toThrow('generation fence');
  });

  it('releases hooks only after the restarted worker writes a matching canonical recovery receipt', () => {
    const release = new ReleaseWindowManager(dataDir);
    const window = release.begin(null);
    release.transition(window.generation, 'hooks_detached');
    release.acknowledgeHookDrain(window.generation);
    release.markWorkerQuiesced(window.generation);
    release.transition(window.generation, 'snapshot_ready');
    release.transition(window.generation, 'artifact_installed', { newArtifactSha256: 'b'.repeat(64) });
    release.transition(window.generation, 'worker_attested');
    release.transition(window.generation, 'hooks_attached');
    const closed = release.transition(window.generation, 'window_closed');
    expect(closed.recoveryBounds.endedAt).toBeTruthy();
    expect(release.canStartWorker()).toBe(false);
    expect(() => release.transition(window.generation, 'recovery_reconciled')).toThrow('Only the restarted worker');
    release.persistCanonicalRecoveryPlan(window.generation, []);
    release.recordCanonicalRecoveryCompletion(window.generation, new SessionStore(':memory:'));
    expect(release.canStartWorker()).toBe(true);
  });

  it('rejects stale, mismatched, and duplicate canonical recovery receipts', () => {
    const release = new ReleaseWindowManager(dataDir);
    const window = release.begin(null);
    release.transition(window.generation, 'hooks_detached'); release.acknowledgeHookDrain(window.generation);
    release.markWorkerQuiesced(window.generation); release.transition(window.generation, 'snapshot_ready');
    release.transition(window.generation, 'artifact_installed'); release.transition(window.generation, 'worker_attested');
    release.transition(window.generation, 'hooks_attached'); release.transition(window.generation, 'window_closed');
    const store = new SessionStore(':memory:');
    release.persistCanonicalRecoveryPlan(window.generation, []);
    const receipt = join(dataDir, 'canonical-recovery-receipt-v1.json');
    writeFileSync(receipt, JSON.stringify({ schemaVersion: 1, generation: window.generation + 1, windowId: window.id, recoveryBounds: { startedAt: 'x', endedAt: 'y' }, workerPid: 2, completedAt: new Date().toISOString(), candidateKeys: [] }));
    expect(() => release.recordCanonicalRecoveryCompletion(window.generation, store)).toThrow('stale, mismatched');
    rmSync(receipt);
    expect(release.recordCanonicalRecoveryCompletion(window.generation, store).phase).toBe('recovery_reconciled');
    expect(() => release.recordCanonicalRecoveryCompletion(window.generation, store)).toThrow('matching closed');
  });

  it('keeps the fence for retry, dead-letter, and unresolved finite recovery candidates', () => {
    const release = new ReleaseWindowManager(dataDir);
    const window = release.begin(null);
    release.transition(window.generation, 'hooks_detached'); release.acknowledgeHookDrain(window.generation);
    release.markWorkerQuiesced(window.generation); release.transition(window.generation, 'snapshot_ready');
    release.transition(window.generation, 'artifact_installed'); release.transition(window.generation, 'worker_attested');
    release.transition(window.generation, 'hooks_attached'); release.transition(window.generation, 'window_closed');
    const key = 'a'.repeat(64); const fingerprint = 'b'.repeat(64);
    const store = new SessionStore(':memory:');
    release.persistCanonicalRecoveryPlan(window.generation, [{ recoveryKey: key, sourceFingerprint: fingerprint, disposition: 'unresolved' }]);
    expect(() => release.recordCanonicalRecoveryCompletion(window.generation, store)).toThrow('remains unresolved');
    expect(release.canStartWorker()).toBe(false);
  });

  it('keeps the fence when a planned job is retrying or dead-lettered', () => {
    const release = new ReleaseWindowManager(dataDir);
    const window = release.begin(null);
    release.transition(window.generation, 'hooks_detached'); release.acknowledgeHookDrain(window.generation);
    release.markWorkerQuiesced(window.generation); release.transition(window.generation, 'snapshot_ready');
    release.transition(window.generation, 'artifact_installed'); release.transition(window.generation, 'worker_attested');
    release.transition(window.generation, 'hooks_attached'); release.transition(window.generation, 'window_closed');
    const key = 'c'.repeat(64); const fingerprint = 'd'.repeat(64);
    const store = new SessionStore(':memory:');
    store.enqueueRecoveryJob({ contentSessionId: 'window-turn', recoveryKind: 'session_summary', project: 'project', platformSource: 'codex', reason: 'release', recoveryKey: key, sourceFingerprint: fingerprint });
    store.db.prepare("UPDATE recovery_jobs SET status='retry_wait' WHERE recovery_key=?").run(key);
    release.persistCanonicalRecoveryPlan(window.generation, [{ recoveryKey: key, sourceFingerprint: fingerprint, disposition: 'job' }]);
    expect(() => release.recordCanonicalRecoveryCompletion(window.generation, store)).toThrow('not terminally successful');
    store.db.prepare("UPDATE recovery_jobs SET status='dead_letter' WHERE recovery_key=?").run(key);
    expect(() => release.recordCanonicalRecoveryCompletion(window.generation, store)).toThrow('not terminally successful');
    expect(release.canStartWorker()).toBe(false);
  });

  it('redeems a generation-bound managed start grant exactly once while hooks stay fenced', () => {
    const release = new ReleaseWindowManager(dataDir);
    const window = release.begin(null);
    release.transition(window.generation, 'hooks_detached');
    release.acknowledgeHookDrain(window.generation);
    release.markWorkerQuiesced(window.generation);
    release.transition(window.generation, 'snapshot_ready');
    release.transition(window.generation, 'artifact_installed');
    const grant = release.issueManagedStartAuthorization(window.generation);
    expect(grant.token).toMatch(/^[a-f0-9]{64}$/);
    expect(() => release.issueManagedStartAuthorization(window.generation)).toThrow('outstanding');
    expect(release.canStartWorker()).toBe(false);
    expect(release.canRequestWorkerStart(grant.token)).toBe(true);
    expect(release.canRequestWorkerStart(grant.token)).toBe(true);
    expect(release.canStartWorker(grant.token)).toBe(true);
    expect(release.canRequestWorkerStart(grant.token)).toBe(false);
    expect(release.canStartWorker(grant.token)).toBe(false);
  });

  it('fails closed for a concurrent mutation or malformed state instead of allowing a hook start', () => {
    const release = new ReleaseWindowManager(dataDir);
    const window = release.begin(null);
    const lock = join(dataDir, 'release-window-v1.json.mutation-lock');
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const startToken = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const nonce = 'b'.repeat(32); const prepared = `${lock}.prepared.${nonce}`;
    mkdirSync(prepared); writeFileSync(join(prepared, 'owner.json'), JSON.stringify({ pid: process.pid, startToken, nonce })); symlinkSync(prepared, lock);
    expect(() => release.transition(window.generation, 'hooks_detached')).toThrow('mutation already in progress');
    expect(release.canStartWorker()).toBe(false);
    rmSync(lock, { recursive: true });
    writeFileSync(join(dataDir, 'release-window-v1.json'), '{bad json}\n');
    expect(release.isMaintenanceActive()).toBe(true);
    expect(release.canStartWorker()).toBe(false);
    expect(() => release.begin(null)).toThrow('unreadable');
  });

  it('recovers a mutation lock left by a SIGKILLed owner', () => {
    const release = new ReleaseWindowManager(dataDir);
    const window = release.begin(null);
    const lock = join(dataDir, 'release-window-v1.json.mutation-lock'); const nonce='a'.repeat(32); const prepared=`${lock}.prepared.${nonce}`; mkdirSync(prepared); writeFileSync(join(prepared, 'owner.json'), JSON.stringify({ pid: 999999, startToken: 'dead', nonce })); symlinkSync(prepared, lock);
    expect(release.transition(window.generation, 'hooks_detached').phase).toBe('hooks_detached');
  });

  it('fails closed on a partially initialized lock directory', () => {
    const release = new ReleaseWindowManager(dataDir); const window = release.begin(null);
    mkdirSync(join(dataDir, 'release-window-v1.json.mutation-lock'));
    expect(() => release.transition(window.generation, 'hooks_detached')).toThrow('incomplete');
  });

  it('requires rollback before recording failure', () => {
    const release = new ReleaseWindowManager(dataDir);
    const window = release.begin(null);
    expect(() => release.transition(window.generation, 'failed')).toThrow('only valid after rollback');
    release.transition(window.generation, 'rolling_back', { rollbackReceipt: 'restoring old artifact' });
    expect(release.transition(window.generation, 'failed', { rollbackReceipt: 'restored' }).phase).toBe('failed');
  });

  it('does not acknowledge drain while an entered hook still holds its durable lease', () => {
    const release = new ReleaseWindowManager(dataDir);
    const leave = release.tryAcquireHookLease();
    expect(leave).toBeFunction();
    const window = release.begin(null);
    release.transition(window.generation, 'hooks_detached');
    expect(() => release.acknowledgeHookDrainAfterLeases(window.generation)).toThrow('hook leases remain');
    leave?.();
    expect(release.acknowledgeHookDrainAfterLeases(window.generation).phase).toBe('hooks_drained');
  });
});
