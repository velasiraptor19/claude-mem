import express, { type Request, type Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import type { RecoveryConsumer } from '../../../recovery/RecoveryConsumer.js';
import { HistoricalRecoveryScanner } from '../../../recovery/HistoricalRecoveryScanner.js';
import { RecoveryJobService } from '../../../recovery/RecoveryJobService.js';
import { logger } from '../../../../utils/logger.js';

type ScanState = { status: 'running' | 'completed' | 'failed'; report?: unknown; error?: string };
const scans = new Map<string, ScanState>();
const MAX_RETAINED_SCANS = 20;
const TRANSCRIPT_STABILITY_MS = 5 * 60_000;
let activeScanId: string | null = null;
function retainBounded(): void {
  while (scans.size > MAX_RETAINED_SCANS) {
    const oldest = [...scans.keys()].find(id => id !== activeScanId);
    if (!oldest) break;
    scans.delete(oldest);
  }
}

export class RecoveryRoutes extends BaseRouteHandler {
  constructor(private readonly db: DatabaseManager, private readonly consumer: () => RecoveryConsumer | null, private readonly reconcileRelease?: (generation: number) => Promise<void>) { super(); }
  setupRoutes(app: express.Application): void {
    app.get('/api/recovery/status', this.status);
    app.post('/api/recovery/scan', this.scan);
    app.post('/api/recovery/reconcile-release', this.reconcile);
    app.get('/api/recovery/scan/:id', this.scanStatus);
    app.post('/api/recovery/:id/cancel', this.cancel);
    app.post('/api/recovery/:id/retry', this.retry);
  }
  private reconcile = this.wrapHandler(async (req: Request, res: Response) => {
    const generation = req.body?.generation;
    if (!Number.isSafeInteger(generation) || generation < 1) {
      res.status(400).json({ error: 'positive integer generation required' }); return;
    }
    if (!this.reconcileRelease) { res.status(503).json({ error: 'release recovery unavailable' }); return; }
    await this.reconcileRelease(generation);
    res.json({ generation, status: 'recovery_reconciled' });
  });
  private status = this.wrapHandler((_req: Request, res: Response) => {
    res.json({ counts: this.db.getSessionStore().getRecoveryJobCounts(), consumer: this.consumer()?.status() ?? { running: false, activeJobId: null, processed: 0 } });
  });
  private scan = this.wrapHandler((req: Request, res: Response) => {
    if (req.body?.roots !== undefined) { res.status(400).json({ error: 'custom transcript roots are not accepted' }); return; }
    const maxEnqueue = req.body?.maxEnqueue === undefined ? Number.POSITIVE_INFINITY : Number(req.body.maxEnqueue);
    if (!(maxEnqueue === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxEnqueue) && maxEnqueue > 0 && maxEnqueue <= 100))) {
      res.status(400).json({ error: 'maxEnqueue must be an integer from 1 to 100' }); return;
    }
    if (activeScanId) { res.status(409).json({ error: 'scan already running', scanId: activeScanId }); return; }
    const id = crypto.randomUUID();
    activeScanId = id;
    scans.set(id, { status: 'running' });
    void new HistoricalRecoveryScanner(this.db.getSessionStore(), undefined, undefined, TRANSCRIPT_STABILITY_MS).scan(req.body?.dryRun !== false, maxEnqueue).then(report => {
      scans.set(id, { status: 'completed', report });
      logger.info('SESSION', 'Historical transcript scan completed', { scanId: id, files: report.files, enqueued: report.enqueued, dryRun: req.body?.dryRun !== false });
    }).catch(error => {
      scans.set(id, { status: 'failed', error: 'scan_failed' });
      logger.failure('SESSION', 'Historical transcript scan failed', { scanId: id }, error instanceof Error ? error : new Error(String(error)));
    }).finally(() => { activeScanId = null; retainBounded(); });
    res.status(202).json({ scanId: id, status: 'running' });
  });
  private scanStatus = this.wrapHandler((req: Request, res: Response) => {
    const state = scans.get(String(req.params.id));
    if (!state) { res.status(404).json({ error: 'scan not found' }); return; }
    res.json(state);
  });
  private cancel = this.wrapHandler((req: Request, res: Response) => {
    const id = Number(req.params.id); if (!Number.isSafeInteger(id)) { res.status(400).json({ error: 'invalid recovery job id' }); return; }
    res.json({ cancelled: this.db.getSessionStore().cancelRecoveryJob(id) });
  });
  private retry = this.wrapHandler((req: Request, res: Response) => {
    const id = Number(req.params.id); if (!Number.isSafeInteger(id)) { res.status(400).json({ error: 'invalid recovery job id' }); return; }
    const resumed = new RecoveryJobService(this.db.getSessionStore()).resumeDeadLetter(id);
    if (!resumed) { res.status(409).json({ error: 'job is not a resumable dead letter' }); return; }
    res.json({ resumed: true, id });
  });
}
