#!/usr/bin/env node
/* Durable receipt for an installer transaction.  It contains no credentials. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [action, dataDir, value] = process.argv.slice(2);
if (!action || !dataDir) throw new Error('usage: release-transaction.cjs <begin|phase|reconcile|abort|complete> <data-dir> [json]');
const root = path.resolve(dataDir);
const file = path.join(root, 'release-transaction-v1.json');
const lock = `${file}.lock`;
const ownerFile = path.join(lock, 'owner.json');
const phases = new Set(['worker_quiesced', 'snapshot_ready', 'artifact_installed', 'worker_attested', 'hooks_attached', 'complete']);
const next = { worker_quiesced: 'snapshot_ready', snapshot_ready: 'artifact_installed', artifact_installed: 'worker_attested', worker_attested: 'hooks_attached', hooks_attached: 'complete' };
const contained = (candidate, parent) => candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
const canonicalExistingDirectory = (candidate) => {
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('release transaction managed directory is not a real directory');
  return fs.realpathSync.native(candidate);
};
const validTarget = (target) => typeof target === 'string' && path.isAbsolute(target) && !target.includes('\0') && path.normalize(target) === target && !target.split(path.sep).includes('..');
function atomic(value) {
  const tmp = path.join(root, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
    // rename durability is not guaranteed until the containing directory is
    // also synced.  The installer relies on this receipt to recover a power
    // loss between transaction and release-window transitions.
    const dirFd = fs.openSync(root, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}
function read() {
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!receipt || receipt.schemaVersion !== 1 || typeof receipt.id !== 'string' || !Number.isSafeInteger(receipt.generation) || receipt.generation < 1 || !phases.has(receipt.phase) || typeof receipt.backupDir !== 'string' || typeof receipt.oldWorkerPath !== 'string' || typeof receipt.oldVersion !== 'string' || !Number.isSafeInteger(receipt.quiescedWorkerPid) || receipt.quiescedWorkerPid < 2 || !Array.isArray(receipt.targets)) throw new Error('release transaction receipt is invalid');
  const backups = canonicalExistingDirectory(path.join(root, 'backups'));
  const backup = path.resolve(receipt.backupDir);
  if (!contained(backup, backups) || backup === backups || !fs.existsSync(backup) || fs.lstatSync(backup).isSymbolicLink() || canonicalExistingDirectory(backup) !== backup) throw new Error('release transaction backup is outside the managed backup root or missing');
  for (const target of receipt.targets) if (!validTarget(target)) throw new Error('release transaction target receipt is invalid');
  return receipt;
}
function archiveTerminal(receipt) {
  if (receipt.phase !== 'complete') throw new Error('only a complete transaction receipt may be archived');
  const history = path.join(root, 'release-transaction-history-v1');
  if (!fs.existsSync(history)) fs.mkdirSync(history, { mode: 0o700 });
  if (fs.lstatSync(history).isSymbolicLink() || !fs.lstatSync(history).isDirectory() || fs.realpathSync.native(history) !== history) throw new Error('release transaction history directory is unsafe');
  const archived = path.join(history, `generation-${receipt.generation}-${receipt.id}.json`);
  if (fs.existsSync(archived)) {
    if (fs.readFileSync(archived, 'utf8') !== fs.readFileSync(file, 'utf8')) throw new Error('archived transaction receipt conflicts with current receipt');
    fs.unlinkSync(file);
  } else {
    fs.renameSync(file, archived);
  }
  const dirFd = fs.openSync(root, 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}
function withLock(fn) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const token = (() => { try { const s=fs.readFileSync(`/proc/${process.pid}/stat`,'utf8'); return s.slice(s.lastIndexOf(')')+2).split(' ')[19] || null; } catch { return null; } })();
  const owner = { pid: process.pid, startToken: token, nonce: crypto.randomBytes(16).toString('hex') };
  let acquired=false;
  for (let attempt=0; attempt<2&&!acquired; attempt++) { const prepared=`${lock}.prepared.${owner.nonce}`; try {
    fs.mkdirSync(prepared,{mode:0o700}); fs.writeFileSync(path.join(prepared,'owner.json'),JSON.stringify(owner),{flag:'wx',mode:0o600}); fs.symlinkSync(prepared,lock); acquired=true;
  } catch(e) {
    try { fs.rmSync(prepared,{recursive:true,force:true}); } catch {}
    if(e.code!=='EEXIST') throw e;
    let p; try { p=JSON.parse(fs.readFileSync(ownerFile,'utf8')); } catch { throw new Error('release transaction lock is incomplete; refusing unsafe recovery'); }
    if(!/^[a-f0-9]{32}$/i.test(p.nonce)||fs.readlinkSync(lock)!==`${lock}.prepared.${p.nonce}`) throw new Error('release transaction lock ownership is invalid; refusing unsafe recovery');
    let live=null; try { const s=fs.readFileSync(`/proc/${p.pid}/stat`,'utf8'); live=s.slice(s.lastIndexOf(')')+2).split(' ')[19]||null; } catch {}
    let held=Number.isSafeInteger(p.pid)&&p.pid>1&&live!==null&&live===p.startToken;
    if(Number.isSafeInteger(p.pid)&&p.pid>1&&live===null) try { process.kill(p.pid,0); held=true; } catch(probeError) { held=probeError.code!=='ESRCH'; }
    if(held) throw new Error('release transaction mutation already in progress'); const quarantine=`${lock}.stale.${p.nonce}.${owner.nonce}`; try { fs.renameSync(lock,quarantine); } catch(renameError) { if(renameError.code!=='ENOENT') throw renameError; } try { const target=fs.readlinkSync(quarantine); fs.unlinkSync(quarantine); fs.rmSync(target,{recursive:true,force:true}); } catch {}
  } }
  if(!acquired) throw new Error('release transaction mutation already in progress');
  try { return fn(); } finally { try { const p=JSON.parse(fs.readFileSync(ownerFile,'utf8')); if(p.nonce===owner.nonce) { const released=`${lock}.released.${owner.nonce}`; fs.renameSync(lock,released); fs.unlinkSync(released); fs.rmSync(`${lock}.prepared.${owner.nonce}`,{recursive:true,force:true}); } } catch {} }
}
function validateRollbackReceipt(receipt) {
  if (receipt.phase === 'worker_quiesced') return;
  const state = path.join(receipt.backupDir, 'database-snapshot-state');
  if (!fs.existsSync(state) || !['present', 'absent'].includes(fs.readFileSync(state, 'utf8').trim())) throw new Error('release transaction snapshot receipt is missing or invalid');
  if (fs.readFileSync(state, 'utf8').trim() === 'present' && !fs.existsSync(path.join(receipt.backupDir, 'claude-mem.db'))) throw new Error('release transaction database snapshot is missing');
}
withLock(() => {
  if (action === 'begin') {
    const input = JSON.parse(value || '{}');
    const backups = canonicalExistingDirectory(path.join(root, 'backups'));
    const backupDir = path.resolve(input.backupDir || '');
    if (!contained(backupDir, backups) || backupDir === backups || !fs.existsSync(backupDir) || fs.lstatSync(backupDir).isSymbolicLink() || canonicalExistingDirectory(backupDir) !== backupDir) throw new Error('backupDir must be below data-dir/backups');
    // Receipt-first callers may be restarted after the atomic write but
    // before the matching window transition.  Replaying the exact begin is a
    // no-op; a different begin is a generation/backup conflict and fails
    // closed rather than replacing recovery evidence.
    if (fs.existsSync(file)) {
      const existing = read();
      const exactReplay = existing.generation === input.generation && existing.backupDir === backupDir && existing.oldWorkerPath === input.oldWorkerPath && existing.oldVersion === input.oldVersion && existing.quiescedWorkerPid === input.quiescedWorkerPid && JSON.stringify(existing.targets) === JSON.stringify(input.targets);
      if (exactReplay) { console.log(JSON.stringify(existing)); return; }
      if (existing.phase !== 'complete' || existing.generation >= input.generation) throw new Error('transaction begin conflicts with existing durable receipt');
      archiveTerminal(existing);
    }
    const receipt = { schemaVersion: 1, id: crypto.randomUUID(), generation: input.generation, phase: 'worker_quiesced', backupDir, oldWorkerPath: input.oldWorkerPath, oldVersion: input.oldVersion, quiescedWorkerPid: input.quiescedWorkerPid, targets: input.targets, updatedAt: new Date().toISOString() };
    if (!Number.isSafeInteger(receipt.generation) || receipt.generation < 1 || typeof receipt.oldWorkerPath !== 'string' || typeof receipt.oldVersion !== 'string' || !Number.isSafeInteger(receipt.quiescedWorkerPid) || receipt.quiescedWorkerPid < 2 || !Array.isArray(receipt.targets) || receipt.targets.some((target) => !validTarget(target))) throw new Error('invalid transaction begin receipt');
    atomic(receipt); console.log(JSON.stringify(receipt)); return;
  }
  if (action === 'abort') {
    const input = JSON.parse(value || '{}');
    if (!Number.isSafeInteger(input.generation) || input.generation < 1 || typeof input.reason !== 'string' || input.reason.length === 0) throw new Error('invalid no-op abort receipt');
    if (fs.existsSync(file)) {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (existing && existing.schemaVersion === 1 && existing.operation === 'abort' && existing.phase === 'aborted' && existing.generation === input.generation && existing.reason === input.reason) { console.log(JSON.stringify(existing)); return; }
      throw new Error('cannot write no-op abort receipt over an existing transaction');
    }
    const receipt = { schemaVersion: 1, id: crypto.randomUUID(), generation: input.generation, phase: 'aborted', operation: 'abort', reason: input.reason, updatedAt: new Date().toISOString() };
    atomic(receipt); console.log(JSON.stringify(receipt)); return;
  }
  const receipt = read();
  if (action === 'phase') {
    const phase = value;
    if (!phases.has(phase) || phase === 'complete') throw new Error('invalid transaction phase');
    if (receipt.phase === phase) { console.log(JSON.stringify(receipt)); return; }
    if (next[receipt.phase] !== phase) throw new Error('invalid transaction phase');
    receipt.phase = phase; receipt.updatedAt = new Date().toISOString(); atomic(receipt); console.log(JSON.stringify(receipt)); return;
  }
  if (action === 'reconcile') {
    validateRollbackReceipt(receipt);
    // A fresh process cannot prove a partially started replacement is healthy.
    // The safe deterministic branch is therefore symmetric rollback; before a
    // snapshot exists it resumes the next idempotent snapshot stage instead.
    const operation = receipt.phase === 'worker_quiesced' ? 'resume_snapshot' : 'rollback';
    console.log(JSON.stringify({ operation, receipt })); return;
  }
  if (action === 'complete') { receipt.phase = 'complete'; receipt.updatedAt = new Date().toISOString(); atomic(receipt); console.log(JSON.stringify(receipt)); return; }
  throw new Error(`unknown action: ${action}`);
});
