import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const root = join(import.meta.dir, '../..');
const script = join(root, 'scripts/release-transaction.cjs');

describe('durable release transaction reconciliation', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-transaction-')); mkdirSync(join(dataDir, 'backups')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });
  function begin() {
    const backup = join(dataDir, 'backups', 'receipt'); mkdirSync(backup);
    writeFileSync(join(backup, 'database-snapshot-state'), 'present\n'); writeFileSync(join(backup, 'claude-mem.db'), 'snapshot');
    const args = JSON.stringify({ generation: 7, backupDir: backup, oldWorkerPath: '/tmp/old-worker.cjs', oldVersion: '13.14.0', quiescedWorkerPid: 999999, targets: ['/tmp/target'] });
    expect(spawnSync(process.execPath, [script, 'begin', dataDir, args], { encoding: 'utf8' }).status).toBe(0);
  }
  function reconcile() { return JSON.parse(spawnSync(process.execPath, [script, 'reconcile', dataDir], { encoding: 'utf8' }).stdout); }
  it('freshly resumes the idempotent snapshot stage after worker quiescence', () => { begin(); expect(reconcile().operation).toBe('resume_snapshot'); });
  it('freshly chooses validated symmetric rollback after snapshot readiness', () => { begin(); expect(spawnSync(process.execPath, [script, 'phase', dataDir, 'snapshot_ready']).status).toBe(0); expect(reconcile().operation).toBe('rollback'); });
  it('replays each receipt-first durable write after a simulated crash without changing its evidence', () => {
    begin();
    const backup = join(dataDir, 'backups', 'receipt');
    const args = JSON.stringify({ generation: 7, backupDir: backup, oldWorkerPath: '/tmp/old-worker.cjs', oldVersion: '13.14.0', quiescedWorkerPid: 999999, targets: ['/tmp/target'] });
    const first = require('fs').readFileSync(join(dataDir, 'release-transaction-v1.json'), 'utf8');
    expect(spawnSync(process.execPath, [script, 'begin', dataDir, args], { encoding: 'utf8' }).status).toBe(0);
    expect(require('fs').readFileSync(join(dataDir, 'release-transaction-v1.json'), 'utf8')).toBe(first);
    expect(spawnSync(process.execPath, [script, 'phase', dataDir, 'snapshot_ready']).status).toBe(0);
    const snapshotted = require('fs').readFileSync(join(dataDir, 'release-transaction-v1.json'), 'utf8');
    expect(spawnSync(process.execPath, [script, 'phase', dataDir, 'snapshot_ready']).status).toBe(0);
    expect(require('fs').readFileSync(join(dataDir, 'release-transaction-v1.json'), 'utf8')).toBe(snapshotted);
    expect(reconcile().operation).toBe('rollback');
  });
  it('freshly chooses validated symmetric rollback after artifact installation', () => { begin(); expect(spawnSync(process.execPath, [script, 'phase', dataDir, 'snapshot_ready']).status).toBe(0); expect(spawnSync(process.execPath, [script, 'phase', dataDir, 'artifact_installed']).status).toBe(0); expect(reconcile().operation).toBe('rollback'); });
  it('fails closed when a receipt cannot prove which worker was quiesced', () => {
    begin();
    const receipt = join(dataDir, 'release-transaction-v1.json');
    const value = JSON.parse(require('fs').readFileSync(receipt, 'utf8'));
    delete value.quiescedWorkerPid;
    writeFileSync(receipt, `${JSON.stringify(value)}\n`);
    const result = spawnSync(process.execPath, [script, 'reconcile', dataDir], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
  });
  it('rejects phase skips so a fresh process cannot authorize hooks early', () => {
    begin();
    expect(spawnSync(process.execPath, [script, 'phase', dataDir, 'hooks_attached'], { encoding: 'utf8' }).status).not.toBe(0);
  });
  it('durably syncs the receipt file before rename and its parent after rename', () => {
    const source = readFileSync(script, 'utf8');
    const write = source.indexOf('fs.writeFileSync(fd');
    const fileSync = source.indexOf('fs.fsyncSync(fd)');
    const rename = source.indexOf('fs.renameSync(tmp, file)');
    const dirSync = source.indexOf('fs.fsyncSync(dirFd)');
    expect(write).toBeGreaterThan(-1);
    expect(write).toBeLessThan(fileSync);
    expect(fileSync).toBeLessThan(rename);
    expect(rename).toBeLessThan(dirSync);
  });
  it('rejects traversal targets and symlinked receipt backups before reconciliation', () => {
    const backup = join(dataDir, 'backups', 'receipt'); mkdirSync(backup);
    const traversal = JSON.stringify({ generation: 7, backupDir: backup, oldWorkerPath: '/tmp/old-worker.cjs', oldVersion: '13.14.0', quiescedWorkerPid: 999999, targets: ['/tmp/managed/../escape'] });
    expect(spawnSync(process.execPath, [script, 'begin', dataDir, traversal], { encoding: 'utf8' }).status).not.toBe(0);
    const external = mkdtempSync(join(tmpdir(), 'claude-mem-external-backup-'));
    const linked = join(dataDir, 'backups', 'linked'); symlinkSync(external, linked);
    const symlinkReceipt = JSON.stringify({ generation: 7, backupDir: linked, oldWorkerPath: '/tmp/old-worker.cjs', oldVersion: '13.14.0', quiescedWorkerPid: 999999, targets: ['/tmp/target'] });
    expect(spawnSync(process.execPath, [script, 'begin', dataDir, symlinkReceipt], { encoding: 'utf8' }).status).not.toBe(0);
    rmSync(external, { recursive: true, force: true });
  });
});
