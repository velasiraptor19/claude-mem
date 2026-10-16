#!/usr/bin/env node
const { spawnSync } = require('child_process');
const { readFileSync } = require('fs');
const { resolve } = require('path');

const repo = resolve(process.argv[2] || process.cwd());
const pkg = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8'));
const version = pkg.version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('package.json has no valid semantic version');
const upstream = process.argv[3] || `archive/upstream-v${version}`;

function git(args, allowStatusOne = false) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (result.status !== 0 && !(allowStatusOne && result.status === 1)) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
  return result.stdout;
}

const upstreamCommit = git(['rev-parse', `${upstream}^{commit}`]).trim();
const upstreamVersion = JSON.parse(git(['show', `${upstreamCommit}:package.json`])).version;
if (upstreamVersion !== version) throw new Error(`same-version comparison required: working=${version} upstream=${upstreamVersion}`);

const numstat = git(['diff', '--numstat', upstreamCommit, '--', '.'], true).trim().split('\n').filter(Boolean);
let insertions = 0;
let deletions = 0;
for (const line of numstat) {
  const [added, removed] = line.split('\t');
  if (/^\d+$/.test(added)) insertions += Number(added);
  if (/^\d+$/.test(removed)) deletions += Number(removed);
}
const files = git(['diff', '--name-status', upstreamCommit, '--', '.'], true).trim().split('\n').filter(Boolean).map((line) => {
  const [status, ...parts] = line.split('\t');
  return { status, path: parts.join('\t') };
});
const known = new Set(files.map((entry) => entry.path));
const untracked = git(['ls-files', '--others', '--exclude-standard', '--', '.']).trim().split('\n').filter(Boolean);
for (const relative of untracked) {
  if (known.has(relative)) continue;
  const content = readFileSync(resolve(repo, relative));
  if (!content.includes(0)) insertions += content.length === 0 ? 0 : content.toString('utf8').split('\n').length;
  files.push({ status: '??', path: relative });
}
files.sort((a, b) => a.path.localeCompare(b.path));

process.stdout.write(`${JSON.stringify({ schemaVersion: 1, version, upstreamRef: upstream, upstreamCommit,
  workingHead: git(['rev-parse', 'HEAD']).trim(), changedFiles: files.length, insertions, deletions, files }, null, 2)}\n`);
