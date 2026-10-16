import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Bun drains child pipes even while paused; Node exercises native backpressure.
for (const pollDelay of [0, 650]) it(`follows a burst with bounded native reads and byte-exact UTF-8 output (${pollDelay ? 'delayed snapshot delivery' : 'native delivery'})`, () => {
  const result = spawnSync('node', [
    join(import.meta.dir, '../fixtures/worker-logs-follow-chunks.mjs'),
    String(pollDelay),
    join(import.meta.dir, '../../scripts/worker-logs.cjs'),
  ], { encoding: 'utf8', timeout: 35000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}, 40000);
