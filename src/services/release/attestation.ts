import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { resolveDataDir } from '../../shared/paths.js';

/** Public, redacted identity emitted by `claude-mem doctor --json`. */
export interface ReleaseIdentityV1 {
  schemaVersion: 1;
  managedPluginVersion: string;
  workerVersion: string | null;
  workerBundleSha256: string | null;
  approvedManifestSha256: string | null;
  buildAttestation: BuildAttestationV1 | null;
  worker: {
    endpoint: string;
    health: 'healthy' | 'unreachable' | 'unhealthy';
    pid: number | null;
    hookTarget: 'managed' | 'mismatch' | 'unknown';
  };
}

/** Bind a reviewed input tree to the exact generated artifact. */
export interface BuildAttestationV1 {
  schemaVersion: 1;
  createdAt: string;
  sourceInputSha256: string;
  outputBundleSha256: string;
  manifestSha256: string | null;
  sourceRevision: string | null;
  dirty: boolean;
  /** A narrow source approval; it is never a claim about the full build. */
  approvalScope?: {
    id: string;
    version: number;
    manifestSha256: string;
    approvedPaths: string[];
    fullBuildApproved: false;
  };
  buildCommand: string;
}

export interface StoreTopologyIdentityV1 {
  schemaVersion: 1;
  storeInstallationId: string;
  sqliteSchemaVersion: number | null;
  clients: Array<{ client: 'codex' | 'claude'; compatible: boolean; detail: string }>;
}

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

export function sha256File(filePath: string): string | null {
  try {
    return existsSync(filePath) ? sha256(readFileSync(filePath)) : null;
  } catch {
    return null;
  }
}

function statePath(dataDir: string, name: string): string {
  return join(dataDir, name);
}

function readJson<T>(filePath: string): T | null {
  try { return JSON.parse(readFileSync(filePath, 'utf8')) as T; } catch { return null; }
}

function validApprovalScope(scope: BuildAttestationV1['approvalScope']): boolean {
  return scope === undefined || (
    typeof scope.id === 'string' && scope.id.length > 0
    && Number.isSafeInteger(scope.version) && scope.version > 0
    && /^[a-f0-9]{64}$/i.test(scope.manifestSha256)
    && Array.isArray(scope.approvedPaths) && scope.approvedPaths.every(path => typeof path === 'string' && path.length > 0)
    && scope.fullBuildApproved === false
  );
}

/**
 * The UUID deliberately lives beside the store, not in a memory table. This
 * keeps 1A/1B out of the persistent-memory schema migration while surviving
 * restarts and providing an exact identity shared by all managed clients.
 */
export function getOrCreateStoreInstallationId(dataDir = resolveDataDir()): string {
  const filePath = statePath(dataDir, 'store-installation-v1.json');
  const existing = readJson<{ schemaVersion?: unknown; storeInstallationId?: unknown }>(filePath);
  if (existing?.schemaVersion === 1 && typeof existing.storeInstallationId === 'string' && existing.storeInstallationId.length > 0) {
    return existing.storeInstallationId;
  }
  const storeInstallationId = randomUUID();
  writeJsonFileAtomic(filePath, { schemaVersion: 1, storeInstallationId, createdAt: new Date().toISOString() });
  return storeInstallationId;
}

export function readBuildAttestation(dataDir = resolveDataDir()): BuildAttestationV1 | null {
  const candidate = readJson<BuildAttestationV1>(statePath(dataDir, 'build-attestation-v1.json'));
  if (!candidate || candidate.schemaVersion !== 1 || typeof candidate.outputBundleSha256 !== 'string' || !validApprovalScope(candidate.approvalScope) || (candidate.approvalScope && !candidate.dirty)) return null;
  return candidate;
}

export function writeBuildAttestation(attestation: BuildAttestationV1, dataDir = resolveDataDir()): void {
  if (attestation.schemaVersion !== 1 || !/^[a-f0-9]{64}$/i.test(attestation.outputBundleSha256)) {
    throw new Error('Invalid BuildAttestationV1');
  }
  if (attestation.approvalScope && (!attestation.dirty || !validApprovalScope(attestation.approvalScope))) {
    throw new Error('Invalid scoped BuildAttestationV1');
  }
  writeJsonFileAtomic(statePath(dataDir, 'build-attestation-v1.json'), attestation);
}

export function sqliteSchemaVersion(dbPath: string): number | null {
  // SQLite's application `PRAGMA user_version` is stored as a big-endian
  // uint32 at offset 60 in the 100-byte file header. Reading the header keeps
  // doctor usable from the Node npx CLI without opening a second writer.
  try {
    const header = readFileSync(dbPath);
    if (header.length < 64 || header.subarray(0, 16).toString('utf8') !== 'SQLite format 3\u0000') return null;
    return header.readUInt32BE(60);
  } catch {
    return null;
  }
}

export function buildReleaseIdentity(input: {
  managedPluginVersion: string;
  workerVersion: string | null;
  workerBundlePath: string | null;
  manifestPath: string | null;
  workerEndpoint: string;
  workerHealth: ReleaseIdentityV1['worker']['health'];
  workerPid: number | null;
  hookWorkerPath: string | null;
  dataDir?: string;
}): ReleaseIdentityV1 {
  const workerBundleSha256 = input.workerBundlePath ? sha256File(input.workerBundlePath) : null;
  const attestation = readBuildAttestation(input.dataDir);
  const hookBundleSha256 = input.hookWorkerPath ? sha256File(input.hookWorkerPath) : null;
  // Claude and Codex legitimately retain separate cache paths. A path may
  // differ while the selected hook artifact is byte-identical to the running
  // managed worker; the release identity is the digest, not a cache location.
  const hookTarget = !input.hookWorkerPath || !input.workerBundlePath
    ? 'unknown'
    : resolve(input.hookWorkerPath) === resolve(input.workerBundlePath)
      || (workerBundleSha256 !== null && hookBundleSha256 === workerBundleSha256)
        ? 'managed'
        : 'mismatch';
  return {
    schemaVersion: 1,
    managedPluginVersion: input.managedPluginVersion,
    workerVersion: input.workerVersion,
    workerBundleSha256,
    approvedManifestSha256: input.manifestPath ? sha256File(input.manifestPath) : null,
    buildAttestation: attestation,
    worker: { endpoint: input.workerEndpoint, health: input.workerHealth, pid: input.workerPid, hookTarget },
  };
}

export function buildStoreTopologyIdentity(input: {
  dataDir?: string;
  dbPath: string;
  codexCompatible: boolean;
  claudeCompatible: boolean;
}): StoreTopologyIdentityV1 {
  return {
    schemaVersion: 1,
    storeInstallationId: getOrCreateStoreInstallationId(input.dataDir),
    sqliteSchemaVersion: sqliteSchemaVersion(input.dbPath),
    clients: [
      { client: 'codex', compatible: input.codexCompatible, detail: input.codexCompatible ? 'managed hook target' : 'managed hook target unavailable' },
      { client: 'claude', compatible: input.claudeCompatible, detail: input.claudeCompatible ? 'managed plugin artifact' : 'managed plugin artifact unavailable' },
    ],
  };
}
