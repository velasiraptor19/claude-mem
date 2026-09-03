#!/usr/bin/env node
/* Write the redacted, machine-readable release binding after artifact review. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] || null;
}
const manifestPath = option('--manifest');
const bundlePath = option('--bundle');
const dataDir = option('--data-dir');
const repoOption = option('--repo');
const approvalScope = option('--approval-scope') || 'full';
if (!manifestPath || !bundlePath || !dataDir || !['full', 'phase-1a'].includes(approvalScope)) {
  console.error('Usage: write-build-attestation.cjs --manifest <file> --bundle <file> --data-dir <dir> [--approval-scope full|phase-1a]');
  process.exit(2);
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const manifestBytes = fs.readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes);
const repoDir = path.resolve(repoOption || path.dirname(path.dirname(manifestPath)));
// Verify the approved local artifact path first.  The installer may later
// attest its byte-identical staged copy, but it must not redefine the bundle
// location the approval covers.
const verified = JSON.parse(execFileSync(process.execPath, [path.join(repoDir, 'scripts/verify-approved-manifest.cjs'), '--manifest', manifestPath, '--bundle', path.join(repoDir, 'plugin/scripts/worker-service.cjs'), '--repo', repoDir, '--mode', approvalScope], { encoding: 'utf8' }));
const sourceInputSha256 = verified.sourceInputSha256;
if (hash(fs.readFileSync(bundlePath)) !== manifest.approvedBundleSha256) throw new Error('attested bundle does not match approved local worker bundle');
let sourceRevision = null;
let dirty = true;
try {
  sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
  dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' }).trim().length > 0;
} catch { /* a source revision is informative, not a deployment prerequisite */ }
fs.mkdirSync(dataDir, { recursive: true });
const outputPath = path.join(dataDir, 'build-attestation-v1.json');
const temporary = path.join(dataDir, `.build-attestation-${process.pid}.tmp`);
const record = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  sourceInputSha256,
  outputBundleSha256: hash(fs.readFileSync(bundlePath)),
  manifestSha256: verified.manifestSha256,
  sourceRevision,
  // A narrow approval is always honest about the broader dirty tree.
  dirty: approvalScope === 'phase-1a' ? true : dirty,
  approvalScope: approvalScope === 'phase-1a' ? {
    id: manifest.scope.id, version: manifest.scope.version, manifestSha256: verified.manifestSha256,
    approvedPaths: verified.approvedPaths, fullBuildApproved: false,
  } : undefined,
  buildCommand: 'npm run build',
};
fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, outputPath);
console.log(JSON.stringify({ outputPath, outputBundleSha256: record.outputBundleSha256, sourceInputSha256 }, null, 2));
