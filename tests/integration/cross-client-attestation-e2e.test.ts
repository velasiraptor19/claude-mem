import { describe, expect, it } from 'bun:test';
import { runCrossClientAttestationCycle } from '../../scripts/cross-client-attestation-e2e.js';

describe('cross-client shared-store attestation E2E', () => {
  it('proves three isolated Codex <-> Claude cycles with root-writer cleanup', async () => {
    for (let run = 0; run < 3; run += 1) {
      const receipt = await runCrossClientAttestationCycle();
      expect(receipt.directions).toEqual([
        expect.objectContaining({ writer: 'codex', reader: 'claude', retrieved: true, sourcePlatformRetained: true }),
        expect.objectContaining({ writer: 'claude', reader: 'codex', retrieved: true, sourcePlatformRetained: true }),
      ]);
      expect(receipt.cleanup).toEqual({ rootWriter: 'SessionStore', completed: true });
    }
  });
});
