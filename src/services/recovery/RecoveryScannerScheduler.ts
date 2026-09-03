import { logger } from '../../utils/logger.js';

export class RecoveryScannerScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = true;

  constructor(
    private readonly scan: () => Promise<{ enqueued: number; eligible: number; unstableTranscripts: number }>,
    private readonly intervalMs = 10 * 60_000,
    private readonly initialDelayMs = 5 * 60_000,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(this.initialDelayMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  async runNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.runNow().finally(() => this.schedule(this.intervalMs)); }, delay);
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    try {
      const report = await this.scan();
      if (report.enqueued || report.unstableTranscripts) logger.info('SESSION', 'Periodic historical recovery scan completed', report);
    } catch (error) {
      logger.failure('SESSION', 'Periodic historical recovery scan failed', {}, error instanceof Error ? error : new Error(String(error)));
    }
  }
}
