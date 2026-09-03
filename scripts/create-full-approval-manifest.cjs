#!/usr/bin/env node
/* Generate a non-scoped approval manifest from an explicit reviewed input list. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function value(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] || null;
}

const repo = path.resolve(value('--repo') || '.');
const inputs = value('--inputs');
const output = value('--output');
if (!inputs || !output) {
  console.error('Usage: create-full-approval-manifest.cjs --inputs <newline-list> --output <manifest> [--repo <dir>]');
  process.exit(2);
}
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const paths = [...new Set(fs.readFileSync(inputs, 'utf8').split(/\r?\n/).filter(Boolean))].sort();
if (paths.length === 0 || paths.some(file => file.startsWith('/') || file.includes('..') || file.includes('\\'))) {
  throw new Error('reviewed input list contains an unsafe path');
}
const files = Object.fromEntries(paths.map(file => {
  const target = path.resolve(repo, file);
  if (!target.startsWith(`${repo}${path.sep}`) || !fs.statSync(target).isFile()) throw new Error(`missing reviewed input: ${file}`);
  return [file, digest(fs.readFileSync(target))];
}));
const manifest = {
  schemaVersion: 1,
  upstreamVersion: '13.14.0',
  upstreamCommit: 'de4930c0410ec9badb21dff98dd7bf409d5aac20',
  approvedBundleSha256: digest(fs.readFileSync(path.join(repo, 'plugin/scripts/worker-service.cjs'))),
  files,
  expectedFileCount: paths.length,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ output, expectedFileCount: paths.length, approvedBundleSha256: manifest.approvedBundleSha256 }, null, 2));
