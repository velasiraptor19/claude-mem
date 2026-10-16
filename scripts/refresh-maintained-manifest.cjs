#!/usr/bin/env node
/*
 * Rebuild the reviewed-source manifest used by maintained-upgrade.sh.
 * Deliberately opt-in: this is a maintainer review action, never part of the
 * ordinary build or installer path.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (!process.argv.includes('--confirm')) {
  console.error('Refusing to refresh an approved manifest without --confirm.');
  process.exit(2);
}

const root = path.resolve(__dirname, '..');
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const manifestPath = path.join(root, 'maintained-patches', `nvidia-recovery-v${packageVersion}.json`);
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
  'src/npx-cli/cmem-memory-credentials.ts',
  'src/npx-cli/commands/ide-detection.ts',
  'src/npx-cli/commands/runtime.ts',
  'src/npx-cli/installer-provider-choice.ts',
  'src/services/integrations/GrokBotInstaller.ts',
  'src/services/worker/http/routes/MemoryRoutes.ts',
  'tests/fixtures/grok-bot-session.jsonl',
  'tests/infrastructure/version-consistency.test.ts',
  'tests/install-error-matrix.test.ts',
  'tests/npx-cli-server-namespace.test.ts',
  'tests/npx-cli/cmem-memory-credentials.test.ts',
  'tests/npx-cli/grok-bot-install-default.test.ts',
  'tests/npx-cli/host-observer-port.test.ts',
  'tests/sdk/prompts.test.ts',
  'tests/sqlite/manual-session-platform.test.ts',
  'tests/transcripts/grok-bot-config.test.ts',
  'tests/worker/http/routes/memory-routes.test.ts',
  'scripts/write-build-attestation.cjs',
  'scripts/release-window.cjs',
  'scripts/refresh-maintained-manifest.cjs',
  'scripts/maintained-diff-report.cjs',
  'AGENTS.md',
  'docs/maintained/UPGRADE_RUNBOOK.md',
  'docs/maintained/UPGRADE_HISTORY.md',
  'docs/maintained/CUSTOMIZATIONS.md',
  'docs/maintained/UPSTREAM_13.14_TO_13.24.md',
  'docs/maintained/RETRIEVAL_BASELINE.md',
  'docs/maintained/GLOBAL_CODEX_AGENTS.md',
  'scripts/verify-retrieval-acceptance.cjs',
  'tests/fixtures/maintained-retrieval-acceptance-v1.json',
  'tests/infrastructure/maintained-policy.test.ts',
];
const sourcePaths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'scripts', 'tests', 'docs/maintained', 'AGENTS.md', 'package.json', 'tsconfig.json', 'bunfig.toml'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const dependencyPath = `maintained-patches/dependencies-v${packageVersion}.json`;
execFileSync(process.execPath, [path.join(root, 'scripts/dependency-tree-manifest.cjs'), 'capture-source', path.join(root, 'node_modules'), path.join(root, dependencyPath)]);
const files = [...new Set([...Object.keys(manifest.files), ...additions, ...sourcePaths, 'bun.lock', dependencyPath])].sort();
manifest.upstreamVersion = packageVersion;
manifest.upstreamCommit = execFileSync('git', ['rev-parse', `archive/upstream-v${packageVersion}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
manifest.dependencyManifest = dependencyPath;
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
scoped.upstreamVersion = manifest.upstreamVersion;
scoped.upstreamCommit = manifest.upstreamCommit;
for (const file of Object.keys(scoped.files)) scoped.files[file] = sha256(file);
scoped.approvedBundleSha256 = manifest.approvedBundleSha256;
scoped.deployedPluginFiles = manifest.deployedPluginFiles;
fs.writeFileSync(scopedPath, `${JSON.stringify(scoped, null, 2)}\n`);
console.log(JSON.stringify({ files: files.length, approvedBundleSha256: manifest.approvedBundleSha256 }, null, 2));
