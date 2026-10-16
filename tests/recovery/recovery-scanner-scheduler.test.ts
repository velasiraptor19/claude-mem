import { describe, expect, it } from 'bun:test';
import { RecoveryScannerScheduler } from '../../src/services/recovery/RecoveryScannerScheduler.js';

describe('RecoveryScannerScheduler', () => {
  it('coalesces concurrent scans and can stop cleanly', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const scheduler = new RecoveryScannerScheduler(async () => {
      calls += 1;
      await gate;
      return { enqueued: 0, eligible: 0, unstableTranscripts: 0 };
    }, 60_000, 60_000);
    const one = scheduler.runNow();
    const two = scheduler.runNow();
    expect(calls).toBe(1);
    release();
    await Promise.all([one, two]);
    await scheduler.stop();
    expect(calls).toBe(1);
  });
});
