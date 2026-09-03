#!/usr/bin/env node
/* Verify either the legacy full manifest or the deliberately narrow Phase-1A approval. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PHASE_1A_SCOPE_ID = 'phase-1a-release-hook-recovery';
const PHASE_1A_SCOPE_VERSION = 1;
const PHASE_1A_ALLOWED_PATHS = Object.freeze([
  'scripts/maintained-upgrade.sh', 'scripts/release-transaction.cjs', 'scripts/release-window.cjs',
  'scripts/verify-approved-manifest.cjs', 'scripts/write-build-attestation.cjs',
  'src/services/recovery/CodexTranscriptRecovery.ts', 'src/services/recovery/HistoricalFingerprintReconciler.ts',
  'src/services/recovery/HistoricalRecoveryScanner.ts', 'src/services/recovery/RecoveryConsumer.ts',
  'src/services/recovery/RecoveryJobService.ts', 'src/services/recovery/RecoveryScannerScheduler.ts',
  'src/services/release/ReleaseWindow.ts', 'src/services/release/attestation.ts',
  'src/services/worker-service.ts', 'src/services/worker-spawner.ts',
]);
function option(name) { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] || null; }
function fail(message) { throw new Error(message); }
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function isDigest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value); }
function safeRelative(file) { return typeof file === 'string' && file.length > 0 && !file.includes('\\') && !file.startsWith('/') && !file.split('/').includes('..') && !file.split('/').includes('.') && path.posix.normalize(file) === file; }
function exactStringArray(actual, expected, label) { if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) fail(`${label} is not the approved stable path set`); }
function readRegularFile(repo, relative, label) {
  if (!safeRelative(relative)) fail(`unsafe ${label} path: ${relative}`);
  const candidate = path.resolve(repo, relative);
  if (!candidate.startsWith(`${repo}${path.sep}`)) fail(`${label} escapes repository: ${relative}`);
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be an existing regular file: ${relative}`);
  return fs.readFileSync(candidate);
}
const manifestPath = option('--manifest'); const bundlePath = option('--bundle'); const requestedMode = option('--mode') || 'full';
const repo = path.resolve(option('--repo') || path.dirname(path.dirname(manifestPath || '.')));
if (!manifestPath || !bundlePath || !['full', 'phase-1a'].includes(requestedMode)) { console.error('Usage: verify-approved-manifest.cjs --manifest <file> --bundle <file> [--repo <dir>] [--mode full|phase-1a]'); process.exit(2); }
try {
  const manifestBytes = fs.readFileSync(manifestPath); const manifest = JSON.parse(manifestBytes);
  if (!manifest || typeof manifest !== 'object' || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) fail('manifest files must be an object');
  const files = Object.keys(manifest.files).sort();
  if (requestedMode === 'phase-1a') {
    const scope = manifest.scope;
    if (manifest.schemaVersion !== 1 || !scope || scope.id !== PHASE_1A_SCOPE_ID || scope.version !== PHASE_1A_SCOPE_VERSION) fail('not a Phase-1A scoped manifest');
    exactStringArray(scope.allowedPaths, PHASE_1A_ALLOWED_PATHS, 'scope.allowedPaths'); exactStringArray(files, PHASE_1A_ALLOWED_PATHS, 'manifest files');
    if (manifest.expectedFileCount !== PHASE_1A_ALLOWED_PATHS.length) fail('scoped manifest expectedFileCount mismatch');
  } else {
    if (manifest.scope !== undefined) fail('scoped manifest requires explicit --mode phase-1a');
    if (!Number.isInteger(manifest.expectedFileCount) || manifest.expectedFileCount < 1 || files.length !== manifest.expectedFileCount) fail('legacy manifest expectedFileCount mismatch');
  }
  for (const file of files) { if (!isDigest(manifest.files[file])) fail(`invalid manifest digest: ${file}`); if (hash(readRegularFile(repo, file, 'source')) !== manifest.files[file]) fail(`manifest hash mismatch: ${file}`); }
  const expectedBundlePath = path.resolve(repo, 'plugin/scripts/worker-service.cjs');
  if (path.resolve(bundlePath) !== expectedBundlePath) fail('bundle path is not the local worker bundle');
  if (!isDigest(manifest.approvedBundleSha256)) fail('invalid approved bundle digest');
  if (hash(readRegularFile(repo, 'plugin/scripts/worker-service.cjs', 'bundle')) !== manifest.approvedBundleSha256) fail('approved bundle hash mismatch');
  process.stdout.write(`${JSON.stringify({ mode: requestedMode, manifestSha256: hash(manifestBytes), sourceInputSha256: hash(files.map(file => `${file}\0${manifest.files[file]}\n`).join('')), approvedPaths: files }, null, 2)}\n`);
} catch (error) { console.error(`manifest verification failed: ${error.message}`); process.exit(1); }
