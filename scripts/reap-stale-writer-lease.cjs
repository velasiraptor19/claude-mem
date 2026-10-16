#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.resolve(process.argv[2] || '');
const runningPid = Number(process.argv[3]);
const window = JSON.parse(fs.readFileSync(path.join(dataDir, 'release-window-v1.json'), 'utf8'));
const startedAt = Date.parse(window.startedAt);
if (window.schemaVersion !== 1 || window.phase !== 'hooks_drained' || window.hookDrainAcknowledged !== true ||
    !Number.isFinite(startedAt) || !Number.isSafeInteger(runningPid) || runningPid < 2) {
  throw new Error('writer lease reconciliation requires a drained release fence and managed worker PID');
}
const lockPath = path.join(dataDir, 'chroma', '.claude-mem-chroma-writer.lock');
if (!fs.existsSync(lockPath)) return;
const stat = fs.lstatSync(lockPath);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o002) !== 0 || ((stat.mode & 0o020) !== 0 && stat.gid !== 0)) {
  throw new Error('writer lease file is untrusted');
}
const raw = fs.readFileSync(lockPath, 'utf8');
const lease = JSON.parse(raw);
if (lease.pid === runningPid) return; // The current worker must release its own lock.
if (!Number.isSafeInteger(lease.pid) || lease.pid < 2 || typeof lease.startToken !== 'string' || !lease.startToken ||
    typeof lease.ownerId !== 'string' || !lease.ownerId.startsWith(`${lease.pid}:`) || lease.dataDir !== path.join(dataDir, 'chroma') ||
    !Number.isFinite(Date.parse(lease.acquiredAt)) || Date.parse(lease.acquiredAt) >= startedAt ||
    stat.mtimeMs >= startedAt) {
  throw new Error('writer lease identity or age is untrusted');
}
try { process.kill(lease.pid, 0); throw new Error('writer lease owner is still alive'); }
catch (error) { if (error.code !== 'ESRCH') throw error; }
if (fs.existsSync(`/proc/${lease.pid}`)) throw new Error('writer lease owner is still visible');
const current = fs.lstatSync(lockPath);
if (current.dev !== stat.dev || current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs || fs.readFileSync(lockPath, 'utf8') !== raw) {
  throw new Error('writer lease changed during reconciliation');
}
fs.unlinkSync(lockPath);
console.error(`reaped proven-dead Chroma writer lease from PID ${lease.pid}`);
