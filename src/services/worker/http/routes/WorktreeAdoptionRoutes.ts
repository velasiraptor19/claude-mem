import crypto from 'node:crypto';
import type express from 'express';
import { requireLocalhost } from '../middleware.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { adoptDeclaredWorktrees } from '../../../infrastructure/WorktreeAdoption.js';
import { logger } from '../../../../utils/logger.js';

/** Local control-plane endpoint. It is deliberately not a general DB API. */
export class WorktreeAdoptionRoutes extends BaseRouteHandler {
  setupRoutes(app: express.Application): void {
    app.post('/api/admin/worktree-adoption', requireLocalhost, this.handle);
  }

  private handle = this.wrapHandler(async (req, res) => {
    const configured = process.env.CLAUDE_MEM_ADOPTION_TOKEN;
    const supplied = req.get('authorization');
    if (!configured || !supplied?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'local adoption authorization required' }); return;
    }
    const candidate = supplied.slice('Bearer '.length);
    const a = Buffer.from(configured), b = Buffer.from(candidate);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'local adoption authorization required' }); return;
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.dryRun !== undefined && typeof body.dryRun !== 'boolean' ||
      typeof body.parentProject !== 'string' || !Array.isArray(body.sources) || body.sources.length < 1 || body.sources.length > 100 ||
      body.sources.some((s: unknown) => !s || typeof s !== 'object' || Array.isArray(s) || typeof (s as any).project !== 'string' || typeof (s as any).branch !== 'string')) {
      res.status(400).json({ error: 'invalid adoption request' }); return;
    }
    // repoPath intentionally comes from the root worker's process CWD. Clients
    // can name declared sources, never an arbitrary filesystem target.
    const result = await adoptDeclaredWorktrees({
      repoPath: process.cwd(), parentProject: body.parentProject,
      sources: body.sources.map((s: { project: string; branch: string }) => ({ project: s.project, branch: s.branch })),
      dryRun: body.dryRun === true,
    });
    if (!result.dryRun && (result.chromaPending ?? result.chromaFailed) > 0) {
      res.status(202).json({ status: 'pending_chroma_reconciliation', result }); return;
    }
    res.status(200).json({ status: result.dryRun ? 'dry_run' : 'complete', result });
  });
}
