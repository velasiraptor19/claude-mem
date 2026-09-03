/**
 * Isolated shared-store proof for the two supported hook clients.
 *
 * This intentionally uses the same SQLite store and HTTP retrieval route as
 * the worker, but never starts a provider, writes the managed store, or reads
 * a real transcript.  A run creates two TTL-namespaced client records, proves
 * Codex -> Claude and Claude -> Codex retrieval through localhost HTTP, then
 * removes its entire temporary root and reports the cleanup receipt.
 */
import express from 'express';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../src/services/worker/SearchManager.js';
import { FormattingService } from '../src/services/worker/FormattingService.js';
import { TimelineService } from '../src/services/worker/TimelineService.js';
import { SearchRoutes } from '../src/services/worker/http/routes/SearchRoutes.js';
import { ModeManager } from '../src/services/domain/ModeManager.js';
import { getOrCreateStoreInstallationId } from '../src/services/release/attestation.js';

export interface CrossClientCycleReceiptV1 {
  schemaVersion: 1;
  namespace: string;
  storeInstallationId: string;
  directions: Array<{
    writer: 'codex' | 'claude';
    reader: 'codex' | 'claude';
    observationId: number;
    retrieved: boolean;
    sourcePlatformRetained: boolean;
  }>;
  cleanup: { rootWriter: 'SessionStore'; completed: boolean };
}

function listen(app: express.Express): Promise<{ server: ReturnType<express.Express['listen']>; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('isolated attestation server did not expose a TCP port'));
        return;
      }
      resolve({ server, port: address.port });
    });
    server.once('error', reject);
  });
}

function close(server: ReturnType<express.Express['listen']>): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export async function runCrossClientAttestationCycle(): Promise<CrossClientCycleReceiptV1> {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'claude-mem-cross-client-attestation-'));
  const namespace = `attestation-v1-${Date.now()}-${randomUUID()}`;
  const storeInstallationId = getOrCreateStoreInstallationId(temporaryRoot);
  const db = new Database(join(temporaryRoot, 'claude-mem.db'));
  const store = new SessionStore(db);
  const search = new SessionSearch(db);
  const app = express();
  // Search formatting is initialized during real worker startup.  This
  // isolated route harness performs that same non-mutating initialization.
  ModeManager.getInstance().loadMode('code');
  const manager = new SearchManager(search, store, null, new FormattingService(), new TimelineService());
  new SearchRoutes(manager).setupRoutes(app);
  let server: ReturnType<express.Express['listen']> | null = null;
  let receipt: CrossClientCycleReceiptV1 | null = null;

  try {
    const listening = await listen(app);
    server = listening.server;
    const project = namespace;
    const directions: CrossClientCycleReceiptV1['directions'] = [];

    for (const [writer, reader] of [['codex', 'claude'], ['claude', 'codex']] as const) {
      const token = `${namespace}-${writer}-to-${reader}`;
      const contentSessionId = `${namespace}-${writer}-session`;
      const sessionDbId = store.createSDKSession(contentSessionId, project, token, undefined, writer);
      const memorySessionId = `${namespace}-${writer}-memory`;
      store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);
      const saved = store.storeObservation(memorySessionId, project, {
        type: 'discovery',
        title: token,
        subtitle: 'Cross-client attestation fixture',
        facts: [`writer=${writer}`, `reader=${reader}`, `store=${storeInstallationId}`],
        narrative: token,
        concepts: ['attestation'],
        files_read: [],
        files_modified: [],
      }, 1);

      // No platform header: cross-client retrieval must query the one shared
      // store rather than silently apply a same-client filter.
      const response = await fetch(`http://127.0.0.1:${listening.port}/api/search/observations?query=${encodeURIComponent(token)}&project=${encodeURIComponent(project)}`);
      if (!response.ok) throw new Error(`${reader} retrieval returned HTTP ${response.status}: ${await response.text()}`);
      const payload = await response.json() as { content?: Array<{ text?: string }> };
      const retrieved = payload.content?.some(item => item.text?.includes(token)) === true;
      const row = db.prepare('SELECT platform_source FROM sdk_sessions WHERE id = ?').get(sessionDbId) as { platform_source?: string } | undefined;
      const sourcePlatformRetained = row?.platform_source === writer;
      if (!retrieved || !sourcePlatformRetained) {
        throw new Error(`cross-client proof failed for ${writer}->${reader}`);
      }
      directions.push({ writer, reader, observationId: saved.id, retrieved, sourcePlatformRetained });
    }

    receipt = {
      schemaVersion: 1,
      namespace,
      storeInstallationId,
      directions,
      cleanup: { rootWriter: 'SessionStore', completed: false },
    };
  } finally {
    if (server) await close(server);
    store.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (receipt) receipt.cleanup.completed = true;
  }
  if (!receipt) throw new Error('cross-client attestation did not produce a receipt');
  return receipt;
}

async function main(): Promise<void> {
  const countIndex = process.argv.indexOf('--runs');
  const runs = countIndex >= 0 ? Number(process.argv[countIndex + 1]) : 1;
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error('--runs must be an integer from 1 through 20');
  const receipts: CrossClientCycleReceiptV1[] = [];
  for (let index = 0; index < runs; index += 1) {
    const receipt = await runCrossClientAttestationCycle();
    receipts.push(receipt);
  }
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), runs: receipts };
  const reportIndex = process.argv.indexOf('--report');
  if (reportIndex >= 0) {
    const reportPath = process.argv[reportIndex + 1];
    if (!reportPath) throw new Error('--report requires a path');
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify(report));
}

if (import.meta.main) {
  await main();
}
