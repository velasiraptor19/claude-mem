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
const manifestPath = path.join(root, 'maintained-patches', 'nvidia-recovery-v13.14.0.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const additions = [
  'src/npx-cli/commands/doctor.ts',
  'src/services/worker-spawner.ts',
  'src/services/release/ReleaseWindow.ts',
  'src/services/release/attestation.ts',
  'tests/release/attestation.test.ts',
  'scripts/write-build-attestation.cjs',
  'scripts/release-window.cjs',
  'scripts/refresh-maintained-manifest.cjs',
];
const files = [...new Set([...Object.keys(manifest.files), ...additions])].sort();
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
for (const file of files) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Refusing: protected file missing: ${file}`);
  manifest.files[file] = sha256(file);
}
manifest.approvedBundleSha256 = sha256('plugin/scripts/worker-service.cjs');
manifest.files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
manifest.expectedFileCount = files.length;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ files: files.length, approvedBundleSha256: manifest.approvedBundleSha256 }, null, 2));
