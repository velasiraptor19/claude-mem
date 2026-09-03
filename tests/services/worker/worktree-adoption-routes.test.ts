import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import express from 'express';
import type http from 'node:http';
import { requireLocalhost } from '../../../src/services/worker/http/middleware.js';

let adoptionResult: any = {};
mock.module('../../../src/services/infrastructure/WorktreeAdoption.js', () => ({
  adoptDeclaredWorktrees: async () => adoptionResult,
}));
const { WorktreeAdoptionRoutes } = await import('../../../src/services/worker/http/routes/WorktreeAdoptionRoutes.js');

describe('worktree adoption control-plane route', () => {
  let server: http.Server;
  let port: number;
  const token = 'local-test-token';

  beforeEach(async () => {
    process.env.CLAUDE_MEM_ADOPTION_TOKEN = token;
    const app = express();
    app.use(express.json());
    new WorktreeAdoptionRoutes().setupRoutes(app);
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    delete process.env.CLAUDE_MEM_ADOPTION_TOKEN;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  async function request(body: unknown, authorization?: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/admin/worktree-adoption`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body),
    });
  }

  const valid = { parentProject: 'parent', sources: [{ project: 'parent/child', branch: 'feature' }] };

  it('rejects non-loopback clients before route authorization', () => {
    let status = 0;
    requireLocalhost({ ip: '203.0.113.8', path: '/api/admin/worktree-adoption', method: 'POST' } as any, {
      status(code: number) { status = code; return this; }, json() { return this; },
    } as any, () => { throw new Error('must not continue'); });
    expect(status).toBe(403);
  });

  it('requires a bearer token and rejects malformed bodies', async () => {
    expect((await request(valid)).status).toBe(401);
    expect((await request({ ...valid, sources: [] }, `Bearer ${token}`)).status).toBe(400);
  });

  it('returns 202 while durable Chroma proof is pending', async () => {
    adoptionResult = { dryRun: false, chromaPending: 1, chromaFailed: 1 };
    const response = await request(valid, `Bearer ${token}`);
    expect(response.status).toBe(202);
    expect((await response.json()).status).toBe('pending_chroma_reconciliation');
  });

  it('labels dry runs without claiming Chroma proof', async () => {
    adoptionResult = { dryRun: true, chromaPending: undefined, chromaFailed: 0 };
    const response = await request({ ...valid, dryRun: true }, `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('dry_run');
  });
});
