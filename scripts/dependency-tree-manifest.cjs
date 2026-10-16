#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [action, rootArg, manifestArg, destinationArg] = process.argv.slice(2);
if (!['create', 'verify', 'stage', 'capture-source', 'verify-source'].includes(action) || !rootArg || !manifestArg || (action === 'stage' && !destinationArg)) throw new Error('usage: dependency-tree-manifest.cjs <create|verify|stage|capture-source|verify-source> <dependency-root> <manifest> [staged-root]');
const root = path.resolve(rootArg);
const manifestPath = path.resolve(manifestArg);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rootStat = fs.lstatSync(root);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('dependency root must be a non-symlink directory');
const rootReal = fs.realpathSync(root);
const isContained = (resolved, base) => {
  const outside = path.relative(base, resolved);
  return outside !== '..' && !outside.startsWith(`..${path.sep}`) && !path.isAbsolute(outside);
};
const assertContained = (absolute, relative) => {
  const resolved = fs.realpathSync(absolute);
  if (!isContained(resolved, rootReal)) {
    throw new Error(`dependency tree entry resolves outside root: ${relative}`);
  }
};
const rejectAbsoluteLink = target => path.isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target);
function resolveLink(absolute, relative) {
  const target = fs.readlinkSync(absolute);
  if (rejectAbsoluteLink(target)) throw new Error(`dependency tree symlink must be relative: ${relative}`);
  let resolved;
  try { resolved = fs.realpathSync(absolute); } catch { throw new Error(`dependency tree symlink is dangling: ${relative}`); }
  if (!isContained(resolved, rootReal)) throw new Error(`dependency tree symlink resolves outside root: ${relative}`);
  return resolved;
}
function walk(dir, prefix = '', active = new Set(), containmentRoot = rootReal) {
  const realDir = fs.realpathSync(dir);
  if (active.has(realDir)) throw new Error(`dependency tree symlink loop: ${prefix || '.'}`);
  active.add(realDir);
  const result = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const absolute = path.join(dir, name); const relative = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`dependency tree contains symlink: ${relative}`);
    const resolved = fs.realpathSync(absolute);
    if (!isContained(resolved, containmentRoot)) throw new Error(`dependency tree entry resolves outside root: ${relative}`);
    if (stat.isDirectory()) Object.assign(result, walk(absolute, relative, active, containmentRoot));
    else if (stat.isFile()) result[relative] = hash(absolute);
    else throw new Error(`dependency tree contains non-regular entry: ${relative}`);
  }
  active.delete(realDir);
  return result;
}
function dereferencedWalk(dir, prefix = '', active = new Set()) {
  const realDir = fs.realpathSync(dir);
  if (active.has(realDir)) throw new Error(`dependency tree symlink loop: ${prefix || '.'}`);
  active.add(realDir);
  const result = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const absolute = path.join(dir, name); const relative = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(absolute);
    const resolved = stat.isSymbolicLink() ? resolveLink(absolute, relative) : absolute;
    const resolvedStat = fs.statSync(resolved);
    assertContained(resolved, relative);
    if (resolvedStat.isDirectory()) Object.assign(result, dereferencedWalk(resolved, relative, active));
    else if (resolvedStat.isFile()) result[relative] = hash(resolved);
    else throw new Error(`dependency tree contains non-regular entry: ${relative}`);
  }
  active.delete(realDir);
  return result;
}
function writeManifest(files) {
  const tmp = `${manifestPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, manifestPath);
}
function copyDereferenced(source, destination, active = new Set()) {
  const stat = fs.lstatSync(source);
  const resolved = stat.isSymbolicLink() ? resolveLink(source, path.relative(root, source)) : source;
  const real = fs.realpathSync(resolved);
  if (active.has(real)) throw new Error(`dependency tree symlink loop: ${path.relative(root, source)}`);
  const resolvedStat = fs.statSync(resolved);
  assertContained(resolved, path.relative(root, source));
  active.add(real);
  if (resolvedStat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: resolvedStat.mode & 0o777 });
    for (const name of fs.readdirSync(resolved).sort()) copyDereferenced(path.join(resolved, name), path.join(destination, name), active);
  } else if (resolvedStat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(resolved, destination);
    fs.chmodSync(destination, resolvedStat.mode & 0o777);
  } else throw new Error(`dependency tree contains non-regular entry: ${path.relative(root, source)}`);
  active.delete(real);
}
const actual = ['stage', 'capture-source', 'verify-source'].includes(action) ? dereferencedWalk(root) : walk(root);
if (action === 'stage') {
  const destination = path.resolve(destinationArg);
  if (fs.existsSync(destination)) throw new Error('staging destination must not already exist');
  const before = JSON.stringify(actual);
  copyDereferenced(root, destination);
  const after = JSON.stringify(dereferencedWalk(root));
  if (before !== after) throw new Error('dependency source changed during staging');
  const staged = walk(destination, '', new Set(), fs.realpathSync(destination));
  if (JSON.stringify(staged) !== before) throw new Error('dereferenced staged dependency tree differs from source');
  writeManifest(staged);
  process.exit(0);
}
if (action === 'create' || action === 'capture-source') {
  writeManifest(actual);
} else {
  const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!expected || expected.schemaVersion !== 1 || JSON.stringify(actual) !== JSON.stringify(expected.files)) throw new Error('staged dependency tree differs from its exact source manifest');
}
