import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { ReleaseWindowManager } from '../../src/services/release/ReleaseWindow.js';

describe('maintained actual worker entry fence', () => {
  it('rejects direct/default daemons and restart before opening a store', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'maintained-daemon-fence-'));
    try {
      new ReleaseWindowManager(dataDir).begin('a'.repeat(64));
      for (const args of [[], ['--daemon'], ['restart'], ['start']]) {
        const run = spawnSync('bun', [resolve(import.meta.dir, '../../src/services/worker-service.ts'), ...args], {
          encoding: 'utf8', timeout: 10000,
          env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_MEM_MANAGED_START_AUTH: '', CLAUDE_MEM_TELEMETRY_ENABLED: 'false' },
        });
        expect(run.error).toBeUndefined();
        expect(run.status).not.toBe(0);
        expect(existsSync(join(dataDir, 'claude-mem.db'))).toBe(false);
      }
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
});
