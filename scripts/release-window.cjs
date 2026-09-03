#!/usr/bin/env node
/* Durable, locked state machine for the root-managed installer. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const [action, dataDir, value] = process.argv.slice(2);
if (!action || !dataDir) throw new Error('usage: release-window.cjs <begin|hooks_drained|...> <data-dir> [value]');
const file = path.join(dataDir, 'release-window-v1.json');
const lock = `${file}.mutation-lock`;
const ownerFile = path.join(lock, 'owner.json');
const leases = path.join(dataDir, 'release-hook-leases-v1');
const recoveryPlan = path.join(dataDir, 'canonical-recovery-plan-v1.json');
const recoveryReceipt = path.join(dataDir, 'canonical-recovery-receipt-v1.json');
const terminal = new Set(['recovery_reconciled', 'failed']);
const next = { prepared: 'hooks_detached', hooks_detached: 'hooks_drained', hooks_drained: 'worker_quiesced', worker_quiesced: 'snapshot_ready', snapshot_ready: 'artifact_installed', artifact_installed: 'worker_attested', worker_attested: 'hooks_attached', hooks_attached: 'window_closed', window_closed: 'recovery_reconciled' };
const phases = new Set([...Object.keys(next), 'recovery_reconciled', 'rolling_back', 'failed']);
const now = () => new Date().toISOString();
const processToken = pid => { try { const s=fs.readFileSync(`/proc/${pid}/stat`,'utf8'); return s.slice(s.lastIndexOf(')')+2).split(' ')[19] || null; } catch { return null; } };
const owner = { pid: process.pid, startToken: processToken(process.pid), nonce: crypto.randomBytes(16).toString('hex') };
function acquire() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt=0; attempt<2; attempt++) { const prepared=`${lock}.prepared.${owner.nonce}`; try {
    fs.mkdirSync(prepared,{mode:0o700}); const fd=fs.openSync(path.join(prepared,'owner.json'),'wx',0o600); try { fs.writeFileSync(fd,JSON.stringify(owner)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.symlinkSync(prepared,lock); return;
  } catch (e) {
    try { fs.rmSync(prepared,{recursive:true,force:true}); } catch {}
    if (e.code !== 'EEXIST') throw e;
    let prior; try { prior=JSON.parse(fs.readFileSync(ownerFile,'utf8')); } catch { throw new Error('release state mutation lock is incomplete; refusing unsafe recovery'); }
    if(!/^[a-f0-9]{32}$/i.test(prior.nonce)||fs.readlinkSync(lock)!==`${lock}.prepared.${prior.nonce}`) throw new Error('release state mutation lock ownership is invalid; refusing unsafe recovery');
    const live=processToken(prior.pid); let held=Number.isSafeInteger(prior.pid)&&prior.pid>1&&live!==null&&live===prior.startToken;
    if(Number.isSafeInteger(prior.pid)&&prior.pid>1&&live===null) try { process.kill(prior.pid,0); held=true; } catch(probeError) { held=probeError.code!=='ESRCH'; }
    if (held) throw new Error('release state mutation already in progress');
    const quarantine=`${lock}.stale.${prior.nonce}.${owner.nonce}`; try { fs.renameSync(lock,quarantine); } catch (renameError) { if(renameError.code!=='ENOENT') throw renameError; } try { const target=fs.readlinkSync(quarantine); fs.unlinkSync(quarantine); fs.rmSync(target,{recursive:true,force:true}); } catch {}
  } }
  throw new Error('release state mutation already in progress');
}
function release() { try { const current=JSON.parse(fs.readFileSync(ownerFile,'utf8')); if(current.nonce===owner.nonce) { const released=`${lock}.released.${owner.nonce}`; fs.renameSync(lock,released); fs.unlinkSync(released); fs.rmSync(`${lock}.prepared.${owner.nonce}`,{recursive:true,force:true}); } } catch {} }
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
function reapDeadDetachedHookLeases(window) {
  if (window.phase !== 'hooks_detached' || typeof window.hooksDetachedAt !== 'string') throw new Error('dead hook leases may be reaped only after detachment');
  const detachedAt = Date.parse(window.hooksDetachedAt);
  if (!Number.isFinite(detachedAt) || detachedAt > Date.now()) throw new Error('hooks-detached timestamp is invalid');
  let names;
  try { names = fs.readdirSync(leases).filter(name => name.endsWith('.json')); }
  catch (error) { if (error && error.code === 'ENOENT') return; throw new Error('hook lease directory is unreadable; refusing drain acknowledgement'); }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const name of names) {
    const lease = path.join(leases, name);
    const stat = fs.lstatSync(lease);
    if (!stat.isFile() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o022) !== 0) throw new Error('hook lease is unsafe; refusing drain acknowledgement');
    const value = JSON.parse(fs.readFileSync(lease, 'utf8'));
    const acquiredAt = Date.parse(value.acquiredAt);
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 2 || !Number.isFinite(acquiredAt) || acquiredAt > detachedAt || stat.mtimeMs > detachedAt) throw new Error('hook lease is not eligible for detached drain');
    const recordedToken = value.startToken;
    if (recordedToken !== undefined && typeof recordedToken !== 'string') throw new Error('hook lease process identity is invalid');
    const liveToken = processToken(value.pid);
    let active = liveToken !== null && (recordedToken === undefined || liveToken === recordedToken);
    if (liveToken === null) {
      try { process.kill(value.pid, 0); active = true; }
      catch (error) { if (!error || error.code !== 'ESRCH') throw new Error('hook lease PID is unverifiable'); }
    }
    if (!active) fs.unlinkSync(lease);
  }
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
function archiveOlderRecoveryEvidence(current) {
  const history = path.join(dataDir, 'canonical-recovery-history-v1');
  for (const [kind, evidence] of [['plan', recoveryPlan], ['receipt', recoveryReceipt]]) {
    if (!fs.existsSync(evidence)) continue;
    const parsed = JSON.parse(fs.readFileSync(evidence, 'utf8'));
    if (!parsed || parsed.schemaVersion !== 1 || !Number.isSafeInteger(parsed.generation) || parsed.generation < 1) throw new Error(`canonical recovery ${kind} is malformed`);
    if (parsed.generation === current.generation) continue;
    if (parsed.generation > current.generation) throw new Error(`canonical recovery ${kind} is from a newer generation`);
    if (!fs.existsSync(history)) fs.mkdirSync(history, { mode: 0o700 });
    const stat = fs.lstatSync(history);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0) throw new Error('canonical recovery history directory is unsafe');
    const id = typeof parsed.windowId === 'string' && /^[a-f0-9-]+$/i.test(parsed.windowId) ? parsed.windowId : 'legacy';
    const archived = path.join(history, `generation-${parsed.generation}-${id}-${kind}.json`);
    if (fs.existsSync(archived)) {
      if (fs.readFileSync(archived, 'utf8') !== fs.readFileSync(evidence, 'utf8')) throw new Error(`archived canonical recovery ${kind} conflicts with current evidence`);
      fs.unlinkSync(evidence);
    } else fs.renameSync(evidence, archived);
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
      if (!['artifact_installed', 'window_closed', 'rolling_back'].includes(window.phase)) throw new Error(`cannot authorize start at ${window.phase}`);
      if (window.managedStartAuthorization && !window.managedStartAuthorization.consumed) throw new Error('managed start authorization is already outstanding');
      const token = crypto.randomBytes(32).toString('hex');
      window.managedStartAuthorization = { generation: window.generation, token, issuedAt: now(), consumed: false };
      authorizationResult = { generation: window.generation, token };
    } else if (action === 'reconcile_noop') {
      if (!['prepared', 'hooks_detached', 'hooks_drained'].includes(window.phase)) throw new Error(`no-op reconciliation is unsupported from ${window.phase}`);
      window.phase = 'recovery_reconciled';
      window.rollbackReceipt = value || 'no-op reconciliation: original worker remained installed and healthy';
    } else if (action === 'prepare_recovery') {
      if (window.phase !== 'hooks_attached') throw new Error(`canonical recovery preparation is unsupported from ${window.phase}`);
      archiveOlderRecoveryEvidence(window);
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
        reapDeadDetachedHookLeases(window);
        const count = activeHookLeaseCount();
        if (count !== 0) throw new Error(`cannot acknowledge hook drain while ${count} hook lease(s) remain`);
        window.hookDrainAcknowledged = true;
      }
      if (action === 'worker_quiesced' && !window.hookDrainAcknowledged) throw new Error('cannot quiesce before explicit hook drain acknowledgement');
      if (action === 'artifact_installed') window.newArtifactSha256 = value || null;
      if (action === 'hooks_detached') window.hooksDetachedAt = now();
      if (action === 'window_closed') window.recoveryBounds.endedAt = now();
      window.phase = action;
    }
    window.updatedAt = now(); write(window);
  }
  console.log(JSON.stringify(authorizationResult || read()));
} finally { release(); }
