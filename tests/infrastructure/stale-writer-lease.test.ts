import { afterEach, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const script = path.resolve(import.meta.dir, '../../scripts/reap-stale-writer-lease.cjs');

function fixture(pid: number, overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-stale-writer-'));
  fixtures.push(dir);
  mkdirSync(path.join(dir, 'chroma'));
  const startedAt = new Date().toISOString();
  writeFileSync(path.join(dir, 'release-window-v1.json'), JSON.stringify({ schemaVersion: 1, phase: 'hooks_drained', hookDrainAcknowledged: true, startedAt }));
  const lock = path.join(dir, 'chroma', '.claude-mem-chroma-writer.lock');
  writeFileSync(lock, JSON.stringify({ pid, ownerId: `${pid}:old-owner`, startToken: 'old-token', dataDir: path.join(dir, 'chroma'), acquiredAt: '2026-01-01T00:00:00Z', ...overrides }), { mode: 0o600 });
  utimesSync(lock, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  return { dir, lock };
}

it('reaps only a proven-dead older Chroma writer lease under a drained fence', () => {
  const { dir, lock } = fixture(2147483646);
  const run = spawnSync(process.execPath, [script, dir, String(process.pid)], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  expect(existsSync(lock)).toBe(false);
});

it('preserves a live or mismatched Chroma writer lease', () => {
  const current = fixture(process.pid);
  const own = spawnSync(process.execPath, [script, current.dir, String(process.pid)], { encoding: 'utf8' });
  expect(own.status).toBe(0);
  expect(existsSync(current.lock)).toBe(true);

  const otherLive = fixture(process.ppid);
  const blocked = spawnSync(process.execPath, [script, otherLive.dir, String(process.pid)], { encoding: 'utf8' });
  expect(blocked.status).not.toBe(0);
  expect(existsSync(otherLive.lock)).toBe(true);

  const wrong = fixture(2147483646, { dataDir: '/other/store/chroma' });
  const run = spawnSync(process.execPath, [script, wrong.dir, String(process.pid)], { encoding: 'utf8' });
  expect(run.status).not.toBe(0);
  expect(existsSync(wrong.lock)).toBe(true);
});
