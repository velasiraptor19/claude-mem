#!/usr/bin/env node
/*
 * Rebuild the reviewed-source manifest used by maintained-upgrade.sh.
 * Deliberately opt-in: this is a maintainer review action, never part of the
 * ordinary build or installer path.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

if (!process.argv.includes('--confirm')) {
  console.error('Refusing to refresh an approved manifest without --confirm.');
  process.exit(2);
}

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'maintained-patches', 'nvidia-recovery-v13.23.1.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const additions = [
  'src/services/infrastructure/WorktreeAdoption.ts',
  'src/npx-cli/commands/doctor.ts',
  'src/services/worker-spawner.ts',
  'src/services/release/ReleaseWindow.ts',
  'src/services/release/attestation.ts',
  'src/services/worker/provider-dispatch.ts',
  'src/shared/quota-cooldown.ts',
  'scripts/release-transaction.cjs',
  'scripts/dependency-tree-manifest.cjs',
  'scripts/verify-approved-manifest.cjs',
  'tests/release/attestation.test.ts',
  'tests/npx-cli/provider-account-gate.test.ts',
  'tests/worker/sync/mutation-sites.test.ts',
  'scripts/write-build-attestation.cjs',
  'scripts/release-window.cjs',
  'scripts/refresh-maintained-manifest.cjs',
];
const files = [...new Set([...Object.keys(manifest.files), ...additions])].sort();
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const walkRegular = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  if (entry.name === 'node_modules') return [];
  const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isDirectory()) return walkRegular(path.join(dir, entry.name), relative);
  if (entry.isFile()) return [relative];
  return [];
});
for (const file of files) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Refusing: protected file missing: ${file}`);
  manifest.files[file] = sha256(file);
}
manifest.approvedBundleSha256 = sha256('plugin/scripts/worker-service.cjs');
manifest.deployedPluginFiles = Object.fromEntries(walkRegular(path.join(root, 'plugin')).sort().map(file => [file, sha256(`plugin/${file}`)]));
manifest.files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
manifest.expectedFileCount = files.length;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const scopedPath = path.join(root, 'maintained-patches', 'phase-1a-release-hook-recovery-v1.json');
const scoped = JSON.parse(fs.readFileSync(scopedPath, 'utf8'));
for (const file of Object.keys(scoped.files)) scoped.files[file] = sha256(file);
scoped.approvedBundleSha256 = manifest.approvedBundleSha256;
scoped.deployedPluginFiles = manifest.deployedPluginFiles;
fs.writeFileSync(scopedPath, `${JSON.stringify(scoped, null, 2)}\n`);
console.log(JSON.stringify({ files: files.length, approvedBundleSha256: manifest.approvedBundleSha256 }, null, 2));
