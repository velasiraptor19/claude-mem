import { describe, expect, it } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';
import { tmpdir } from 'os';

const root = path.resolve(import.meta.dir, '../..');
const verifier = path.join(root, 'scripts/verify-approved-manifest.cjs');
const writer = path.join(root, 'scripts/write-build-attestation.cjs');
const scopedManifest = JSON.parse(readFileSync(path.join(root, 'maintained-patches/phase-1a-release-hook-recovery-v1.json'), 'utf8'));
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function fixture() {
  const repo = mkdtempSync(path.join(tmpdir(), 'claude-mem-scoped-attestation-'));
  for (const source of Object.keys(scopedManifest.files)) {
    const target = path.join(repo, source); mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(path.join(root, source), target);
  }
  const bundle = path.join(repo, 'plugin/scripts/worker-service.cjs'); mkdirSync(path.dirname(bundle), { recursive: true }); copyFileSync(path.join(root, 'plugin/scripts/worker-service.cjs'), bundle);
  // This isolated fixture models a reviewed scoped approval over the copied
  // source. Keep the checked-in manifest immutable: it is production
  // approval material, not a test fixture update mechanism.
  const fixtureManifest = {
    ...scopedManifest,
    files: Object.fromEntries(Object.keys(scopedManifest.files).map((source) => [source, hash(path.join(repo, source))])),
    approvedBundleSha256: hash(bundle),
  };
  const manifest = path.join(repo, 'phase-1a.json'); writeFileSync(manifest, `${JSON.stringify(fixtureManifest, null, 2)}\n`);
  return { repo, bundle, manifest };
}
function verify(repo: string, manifest: string, bundle: string, mode = 'phase-1a') {
  return spawnSync(process.execPath, [verifier, '--repo', repo, '--manifest', manifest, '--bundle', bundle, '--mode', mode], { encoding: 'utf8' });
}

describe('scoped Phase-1A approval manifests', () => {
  it('binds only its stable source set and local worker bundle', () => {
    const f = fixture();
    try {
      const run = verify(f.repo, f.manifest, f.bundle);
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout).approvedPaths).toEqual(scopedManifest.scope.allowedPaths);
    } finally { rmSync(f.repo, { recursive: true, force: true }); }
  });

  it('rejects traversal and extra paths instead of extending the narrow approval', () => {
    const f = fixture();
    try {
      const manifest = JSON.parse(readFileSync(f.manifest, 'utf8'));
      manifest.files['../outside.ts'] = '0'.repeat(64);
      writeFileSync(f.manifest, JSON.stringify(manifest));
      const run = verify(f.repo, f.manifest, f.bundle);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('approved stable path set');
    } finally { rmSync(f.repo, { recursive: true, force: true }); }
  });

  it('rejects a mismatched bundle and never accepts an arbitrary bundle path', () => {
    const f = fixture();
    try {
      writeFileSync(f.bundle, 'tampered worker bundle');
      const run = verify(f.repo, f.manifest, f.bundle);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('approved bundle hash mismatch');
    } finally { rmSync(f.repo, { recursive: true, force: true }); }
  });

  it('records scoped approval as dirty and does not silently trust an unlisted change', () => {
    const f = fixture();
    try {
      const unlisted = path.join(f.repo, 'src/unreviewed-feature.ts'); mkdirSync(path.dirname(unlisted), { recursive: true }); writeFileSync(unlisted, 'not reviewed by Phase-1A\n');
      const result = verify(f.repo, f.manifest, f.bundle);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).approvedPaths).not.toContain('src/unreviewed-feature.ts');
      const data = path.join(f.repo, 'data');
      const write = spawnSync(process.execPath, [writer, '--manifest', f.manifest, '--bundle', f.bundle, '--data-dir', data, '--repo', f.repo, '--approval-scope', 'phase-1a'], { encoding: 'utf8' });
      expect(write.status, write.stderr).toBe(0);
      const attestation = JSON.parse(readFileSync(path.join(data, 'build-attestation-v1.json'), 'utf8'));
      expect(attestation.dirty).toBe(true);
      expect(attestation.approvalScope).toMatchObject({ id: 'phase-1a-release-hook-recovery', version: 1, fullBuildApproved: false });
      expect(attestation.approvalScope.approvedPaths).not.toContain('src/unreviewed-feature.ts');
    } finally { rmSync(f.repo, { recursive: true, force: true }); }
  });

  it('continues to verify a legacy full manifest when full mode is selected', () => {
    const f = fixture();
    try {
      const legacy = { upstreamVersion: '13.14.0', approvedBundleSha256: hash(f.bundle), files: { 'scripts/maintained-upgrade.sh': hash(path.join(f.repo, 'scripts/maintained-upgrade.sh')) }, expectedFileCount: 1 };
      writeFileSync(f.manifest, JSON.stringify(legacy));
      expect(verify(f.repo, f.manifest, f.bundle, 'full').status).toBe(0);
      expect(verify(f.repo, f.manifest, f.bundle).status).not.toBe(0);
    } finally { rmSync(f.repo, { recursive: true, force: true }); }
  });
});
