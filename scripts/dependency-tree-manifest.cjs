#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [action, rootArg, manifestArg] = process.argv.slice(2);
if (!['create', 'verify'].includes(action) || !rootArg || !manifestArg) throw new Error('usage: dependency-tree-manifest.cjs <create|verify> <dependency-root> <manifest>');
const root = path.resolve(rootArg);
const manifestPath = path.resolve(manifestArg);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function walk(dir, prefix = '') {
  const result = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const absolute = path.join(dir, name); const relative = prefix ? `${prefix}/${name}` : name;
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) Object.assign(result, walk(absolute, relative));
    else if (stat.isFile()) result[relative] = hash(absolute);
    else throw new Error(`dependency tree contains non-regular entry: ${relative}`);
  }
  return result;
}
const actual = walk(root);
if (action === 'create') {
  const tmp = `${manifestPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, files: actual }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, manifestPath);
} else {
  const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!expected || expected.schemaVersion !== 1 || JSON.stringify(actual) !== JSON.stringify(expected.files)) throw new Error('staged dependency tree differs from its exact source manifest');
}
