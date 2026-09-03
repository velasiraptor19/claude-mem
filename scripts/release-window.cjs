#!/usr/bin/env node
/* Durable, locked state machine for the root-managed installer. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const [action, dataDir, value] = process.argv.slice(2);
if (!action || !dataDir) throw new Error('usage: release-window.cjs <begin|hooks_drained|...> <data-dir> [value]');
const file = path.join(dataDir, 'release-window-v1.json');
const lock = `${file}.mutation-lock`;
const leases = path.join(dataDir, 'release-hook-leases-v1');
const terminal = new Set(['recovery_reconciled', 'failed']);
const next = { prepared: 'hooks_detached', hooks_detached: 'hooks_drained', hooks_drained: 'worker_quiesced', worker_quiesced: 'snapshot_ready', snapshot_ready: 'artifact_installed', artifact_installed: 'worker_attested', worker_attested: 'hooks_attached', hooks_attached: 'window_closed', window_closed: 'recovery_reconciled' };
const phases = new Set([...Object.keys(next), 'recovery_reconciled', 'rolling_back', 'failed']);
const now = () => new Date().toISOString();
function acquire() { fs.mkdirSync(path.dirname(file), { recursive: true }); try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw new Error('release state mutation already in progress'); throw e; } }
function release() { try { fs.rmdirSync(lock); } catch {} }
function validate(window) {
  const grant = window && window.managedStartAuthorization;
  if (!window || window.schemaVersion !== 1 || typeof window.id !== 'string' || !Number.isSafeInteger(window.generation) || window.generation < 1 || !phases.has(window.phase) || typeof window.hookDrainAcknowledged !== 'boolean' || !window.recoveryBounds || typeof window.recoveryBounds.startedAt !== 'string' || (grant !== undefined && (!grant || grant.generation !== window.generation || !/^[a-f0-9]{64}$/i.test(grant.token) || typeof grant.issuedAt !== 'string' || typeof grant.consumed !== 'boolean'))) {
    throw new Error('release window state is invalid; refusing to bypass maintenance fence');
  }
  return window;
}
function read() { return validate(JSON.parse(fs.readFileSync(file, 'utf8'))); }
function activeHookLeaseCount() {
  try { return fs.readdirSync(leases).filter(name => name.endsWith('.json')).length; }
  catch (error) { if (error && error.code === 'ENOENT') return 0; throw new Error('hook lease directory is unreadable; refusing drain acknowledgement'); }
}
function write(value) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  let dirFd;
  try {
    dirFd = fs.openSync(path.dirname(file), 'r');
    fs.fsyncSync(dirFd);
  } finally {
    if (dirFd !== undefined) {
      try { fs.closeSync(dirFd); } catch {}
    }
  }
}
acquire();
let authorizationResult = null;
try {
  if (action === 'begin') {
    let prior = null;
    if (fs.existsSync(file)) prior = read();
    if (prior && !terminal.has(prior.phase)) throw new Error(`active release window at ${prior.phase}`);
    const at = now();
    write({ schemaVersion: 1, id: crypto.randomUUID(), generation: (prior?.generation || 0) + 1, phase: 'prepared', startedAt: at, updatedAt: at, hookDrainAcknowledged: false, oldArtifactSha256: value || null, newArtifactSha256: null, recoveryBounds: { startedAt: at } });
  } else {
    const window = read();
    if (terminal.has(window.phase)) throw new Error(`cannot mutate terminal release window at ${window.phase}`);
    if (action === 'rolling_back') {
      if (window.phase === 'rolling_back') { console.log(JSON.stringify(window)); return; }
      window.phase = 'rolling_back'; window.rollbackReceipt = value || 'rollback in progress';
    } else if (action === 'fail') {
      if (window.phase !== 'rolling_back') throw new Error('failure is only valid after rollback');
      window.phase = 'failed'; window.rollbackReceipt = value || 'installer failure';
    } else if (action === 'authorize_start') {
      if (!['artifact_installed', 'rolling_back'].includes(window.phase)) throw new Error(`cannot authorize start at ${window.phase}`);
      if (window.managedStartAuthorization && !window.managedStartAuthorization.consumed) throw new Error('managed start authorization is already outstanding');
      const token = crypto.randomBytes(32).toString('hex');
      window.managedStartAuthorization = { generation: window.generation, token, issuedAt: now(), consumed: false };
      authorizationResult = { generation: window.generation, token };
    } else if (action === 'reconcile') {
      // Startup must never silently clear an interrupted release.  The
      // installer can resume only from durable phases it understands; all
      // other interruptions enter the symmetric rollback fence.
      if (window.phase === 'prepared' || window.phase === 'hooks_detached' || window.phase === 'hooks_drained' || window.phase === 'worker_quiesced' || window.phase === 'snapshot_ready' || window.phase === 'artifact_installed' || window.phase === 'worker_attested' || window.phase === 'hooks_attached' || window.phase === 'window_closed') {
        const interruptedPhase = window.phase;
        window.phase = 'rolling_back';
        window.rollbackReceipt = `reconciliation required from interrupted ${interruptedPhase}`;
      } else if (window.phase !== 'rolling_back') {
        throw new Error(`cannot reconcile terminal release window at ${window.phase}`);
      }
    } else {
      if (action === 'recovery_reconciled') throw new Error('only the restarted worker may write a canonical recovery receipt and clear this fence');
      if (next[window.phase] !== action) throw new Error(`invalid release transition ${window.phase} -> ${action}`);
      if (action === 'hooks_drained') {
        const count = activeHookLeaseCount();
        if (count !== 0) throw new Error(`cannot acknowledge hook drain while ${count} hook lease(s) remain`);
        window.hookDrainAcknowledged = true;
      }
      if (action === 'worker_quiesced' && !window.hookDrainAcknowledged) throw new Error('cannot quiesce before explicit hook drain acknowledgement');
      if (action === 'artifact_installed') window.newArtifactSha256 = value || null;
      if (action === 'window_closed') window.recoveryBounds.endedAt = now();
      window.phase = action;
    }
    window.updatedAt = now(); write(window);
  }
  console.log(JSON.stringify(authorizationResult || read()));
} finally { release(); }
