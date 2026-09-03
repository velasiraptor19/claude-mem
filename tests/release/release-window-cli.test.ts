import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const root = join(import.meta.dir, '../..');
const script = join(root, 'scripts/release-window.cjs');

describe('release-window rollback fence', () => {
  let dataDir: string;

  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-release-window-cli-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('keeps the maintenance fence active until rollback is explicitly failed', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    expect(run('begin', dataDir).status).toBe(0);
    expect(run('rolling_back', dataDir, 'rollback in progress').status).toBe(0);

    const rollingBack = JSON.parse(readFileSync(join(dataDir, 'release-window-v1.json'), 'utf8'));
    expect(rollingBack.phase).toBe('rolling_back');
    expect(rollingBack.rollbackReceipt).toBe('rollback in progress');

    expect(run('fail', dataDir, 'rollback restored durable state').status).toBe(0);
    const failed = JSON.parse(readFileSync(join(dataDir, 'release-window-v1.json'), 'utf8'));
    expect(failed.phase).toBe('failed');
    expect(failed.rollbackReceipt).toBe('rollback restored durable state');
  });

  it('never lets the installer clear a closed recovery fence without a worker-owned receipt', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    for (const action of ['hooks_detached', 'hooks_drained', 'worker_quiesced', 'snapshot_ready', 'artifact_installed', 'worker_attested', 'hooks_attached', 'window_closed', 'recovery_reconciled']) {
      expect(run(action, dataDir).status).not.toBe(0);
    }
    expect(run('begin', dataDir).status).toBe(0);
    for (const action of ['hooks_detached', 'hooks_drained', 'worker_quiesced', 'snapshot_ready', 'artifact_installed', 'worker_attested', 'hooks_attached', 'window_closed']) {
      expect(run(action, dataDir).status).toBe(0);
    }
    const closed = readFileSync(join(dataDir, 'release-window-v1.json'), 'utf8');
    for (const action of ['recovery_reconciled', 'hooks_detached']) {
      const result = run(action, dataDir, 'must not mutate');
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(dataDir, 'release-window-v1.json'), 'utf8')).toBe(closed);
    }
  });

  it('issues a generation-bound start authorization only after replacement staging', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    for (const action of ['begin', 'hooks_detached', 'hooks_drained', 'worker_quiesced', 'snapshot_ready', 'artifact_installed']) {
      expect(run(action, dataDir).status).toBe(0);
    }
    const granted = run('authorize_start', dataDir);
    expect(granted.status).toBe(0);
    const grant = JSON.parse(granted.stdout);
    expect(grant.generation).toBe(1);
    expect(grant.token).toMatch(/^[a-f0-9]{64}$/);
    expect(run('authorize_start', dataDir).status).not.toBe(0); // cannot mint a second concurrent start
    expect(JSON.parse(readFileSync(join(dataDir, 'release-window-v1.json'), 'utf8')).managedStartAuthorization.consumed).toBe(false);
  });

  it('fails closed on corrupt durable state and respects an in-flight mutation lock', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    expect(run('begin', dataDir).status).toBe(0);
    const lock = join(dataDir, 'release-window-v1.json.mutation-lock');
    mkdirSync(lock);
    expect(run('hooks_detached', dataDir).status).not.toBe(0);
    rmdirSync(lock);
    writeFileSync(join(dataDir, 'release-window-v1.json'), '{not json}\n');
    expect(run('begin', dataDir).status).not.toBe(0);
  });

  it('does not report a transition as successful when parent-directory fsync fails', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    expect(run('begin', dataDir).status).toBe(0);

    const failureHook = join(dataDir, 'fail-parent-directory-fsync.cjs');
    writeFileSync(failureHook, `
      const fs = require('fs');
      const originalFsyncSync = fs.fsyncSync;
      fs.fsyncSync = function (fd) {
        if (fs.fstatSync(fd).isDirectory()) {
          const error = new Error('simulated parent-directory fsync failure');
          error.code = 'EIO';
          throw error;
        }
        return originalFsyncSync(fd);
      };
    `);

    const result = spawnSync(process.execPath, ['--require', failureHook, script, 'hooks_detached', dataDir], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('simulated parent-directory fsync failure');
  });

  it('refuses drain acknowledgement until durable hook leases are gone, then reconciles interruption into rollback', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    expect(run('begin', dataDir).status).toBe(0);
    expect(run('hooks_detached', dataDir).status).toBe(0);
    const leases = join(dataDir, 'release-hook-leases-v1');
    mkdirSync(leases);
    writeFileSync(join(leases, 'active.json'), '{}\n');
    expect(run('hooks_drained', dataDir).status).not.toBe(0);
    rmSync(join(leases, 'active.json'));
    expect(run('hooks_drained', dataDir).status).toBe(0);
    expect(run('reconcile', dataDir).status).toBe(0);
    const state = JSON.parse(readFileSync(join(dataDir, 'release-window-v1.json'), 'utf8'));
    expect(state.phase).toBe('rolling_back');
    expect(state.rollbackReceipt).toContain('hooks_drained');
  });
});
