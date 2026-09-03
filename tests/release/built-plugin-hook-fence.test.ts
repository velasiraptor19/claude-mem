import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const root = join(import.meta.dir, '../..');
const stateScript = join(root, 'scripts/release-window.cjs');
const builtWorker = join(root, 'plugin/scripts/worker-service.cjs');

describe('built plugin hook release fence', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-built-hook-fence-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('uses the generated worker entrypoint to reject detached hook work before worker startup', () => {
    expect(spawnSync(process.execPath, [stateScript, 'begin', dataDir], { encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync(process.execPath, [stateScript, 'hooks_detached', dataDir], { encoding: 'utf8' }).status).toBe(0);
    const result = spawnSync('bun', [builtWorker, 'hook', 'raw', 'context'], {
      cwd: root,
      encoding: 'utf8',
      input: '',
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SessionStart');
    expect(result.stdout).not.toContain('Failed to start worker');
  });
});
