import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import path from 'path';

const root = path.resolve(import.meta.dir, '../..');
const scriptPath = path.join(root, 'scripts/maintained-upgrade.sh');

const freshShellReconciliationPhases = [
  'worker_quiesced',
  'snapshot_ready',
  'artifact_installed',
  'worker_attested',
  'hooks_attached',
] as const;

type FreshShellReconciliationPhase = (typeof freshShellReconciliationPhases)[number];

function expectFreshShellReconciliation(phase: FreshShellReconciliationPhase) {
  const fixture = path.join('/tmp', `claude-mem-reconcile-${phase}-${process.pid}-${Date.now()}`);
  const backup = path.join(fixture, 'backups', 'receipt');
  mkdirSync(backup, { recursive: true });
  const home = path.join(fixture, 'home');
  const oldWorker = path.join(home, '.claude/plugins/cache/thedotmack/claude-mem/13.14.0/scripts/worker-service.cjs');
  const target = path.join(home, '.claude/plugins/cache/thedotmack/claude-mem/13.14.1');
  mkdirSync(path.dirname(oldWorker), { recursive: true });
  writeFileSync(oldWorker, '// fake managed worker\n');
  const presence = path.join(backup, 'presence'); mkdirSync(path.join(backup, 'targets'), { recursive: true }); mkdirSync(path.join(backup, 'metadata'), { recursive: true }); mkdirSync(presence);
  const markAbsent = (item: string) => writeFileSync(path.join(presence, require('crypto').createHash('sha256').update(item).digest('hex')), 'absent');
  if (phase !== 'worker_quiesced') {
    writeFileSync(path.join(backup, 'database-snapshot-state'), 'absent\n');
    for (const item of [target, path.join(home, '.claude/plugins/installed_plugins.json'), path.join(home, '.claude/plugins/known_marketplaces.json'), path.join(home, '.claude/settings.json'), path.join(home, '.codex/config.toml'), path.join(home, '.codex/hooks.json'), path.join(home, '.local/bin/claude-mem'), path.join(fixture, 'settings.json'), path.join(fixture, 'build-attestation-v1.json'), path.join(fixture, 'chroma')]) markAbsent(item);
  }
  // The durable receipt remains snapshot_ready while each target is
  // replaced, so a crash in that loop must restore this partial target.
  if (['snapshot_ready', 'artifact_installed', 'worker_attested', 'hooks_attached'].includes(phase)) {
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'replacement-asset'), 'must be removed by rollback\n');
  }
  const bin = path.join(fixture, 'bin'); mkdirSync(bin);
  writeFileSync(path.join(bin, 'bun'), `#!/usr/bin/env bash\ntouch ${JSON.stringify(path.join(fixture, 'started'))}\n`);
  writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash\nif [[ -f ${JSON.stringify(path.join(fixture, 'started'))} ]]; then printf %s ${JSON.stringify(JSON.stringify({ status: 'ok', version: '13.14.0', workerPath: oldWorker }))}; exit 0; fi\nexit 7\n`);
  require('fs').chmodSync(path.join(bin, 'bun'), 0o755); require('fs').chmodSync(path.join(bin, 'curl'), 0o755);
  writeFileSync(path.join(fixture, 'release-transaction-v1.json'), JSON.stringify({ schemaVersion: 1, id: 'receipt', generation: 9, phase, backupDir: backup, oldWorkerPath: oldWorker, oldVersion: '13.14.0', quiescedWorkerPid: 999999, targets: [target] }));
  writeFileSync(path.join(fixture, 'release-window-v1.json'), JSON.stringify({ schemaVersion: 1, id: 'window', generation: 9, phase, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hookDrainAcknowledged: true, recoveryBounds: { startedAt: new Date().toISOString() } }));
  const run = spawnSync('bash', [scriptPath, 'reconcile'], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_MEM_UPGRADE_HOME: home, CLAUDE_MEM_DATA_DIR: fixture, CLAUDE_MEM_HEALTH_URL: 'http://127.0.0.1:1/api/health', CLAUDE_MEM_UPGRADE_SKIP_CHECKS: '1' } });
  expect(run.status).toBe(0);
  expect(JSON.parse(readFileSync(path.join(fixture, 'release-window-v1.json'), 'utf8')).phase).toBe('failed');
  expect(JSON.parse(run.stdout).operation).toBe(phase === 'worker_quiesced' ? 'resume_snapshot' : 'rollback');
  expect(readFileSync(path.join(fixture, 'release-transaction-v1.json'), 'utf8')).toContain('complete');
  if (['snapshot_ready', 'artifact_installed', 'worker_attested', 'hooks_attached'].includes(phase)) expect(() => readFileSync(path.join(target, 'replacement-asset'), 'utf8')).toThrow();
  rmSync(fixture, { recursive: true, force: true });
}

describe('maintained upgrade safety', () => {
  it('admits exactly one of two simultaneous release-window contenders', async () => {
    const fixture = path.join('/tmp', `claude-mem-window-contenders-${process.pid}-${Date.now()}`); mkdirSync(fixture);
    const run = () => new Promise<number | null>((resolve) => spawn(process.execPath, [path.join(root, 'scripts/release-window.cjs'), 'begin', fixture], { stdio: 'ignore' }).on('exit', resolve));
    const statuses = await Promise.all([run(), run()]);
    expect(statuses.filter(status => status === 0)).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(fixture, 'release-window-v1.json'), 'utf8')).generation).toBe(1);
    rmSync(fixture, { recursive: true, force: true });
  });

  it('fails closed on partially initialized script lock directories', () => {
    const fixture = path.join('/tmp', `claude-mem-partial-lock-${process.pid}-${Date.now()}`); mkdirSync(fixture);
    mkdirSync(path.join(fixture, 'release-window-v1.json.mutation-lock'));
    const window = spawnSync(process.execPath, [path.join(root, 'scripts/release-window.cjs'), 'begin', fixture], { encoding: 'utf8' });
    expect(window.status).not.toBe(0); expect(window.stderr).toContain('incomplete');
    rmSync(path.join(fixture, 'release-window-v1.json.mutation-lock'), { recursive: true });
    mkdirSync(path.join(fixture, 'release-transaction-v1.json.lock'));
    const transaction = spawnSync(process.execPath, [path.join(root, 'scripts/release-transaction.cjs'), 'begin', fixture, '{}'], { encoding: 'utf8' });
    expect(transaction.status).not.toBe(0); expect(transaction.stderr).toContain('incomplete');
    rmSync(fixture, { recursive: true, force: true });
  });

  it('archives an older complete transaction before beginning a newer generation', () => {
    const source = readFileSync(path.join(root, 'scripts/release-transaction.cjs'), 'utf8');
    expect(source).toContain("existing.phase !== 'complete' || existing.generation >= input.generation");
    expect(source).toContain('release-transaction-history-v1');
    expect(source).toContain('archiveTerminal(existing)');
  });

  it('detects additions and byte changes in an exact dependency tree', () => {
    const fixture = path.join('/tmp', `claude-mem-dependency-tree-${process.pid}-${Date.now()}`); const source = path.join(fixture, 'source'); const staged = path.join(fixture, 'staged');
    mkdirSync(source, { recursive: true }); mkdirSync(staged); writeFileSync(path.join(source, 'a.js'), 'one'); writeFileSync(path.join(staged, 'a.js'), 'one');
    const manifest = path.join(fixture, 'manifest.json'); const tool = path.join(root, 'scripts/dependency-tree-manifest.cjs');
    expect(spawnSync(process.execPath, [tool, 'create', source, manifest]).status).toBe(0);
    expect(spawnSync(process.execPath, [tool, 'verify', staged, manifest]).status).toBe(0);
    writeFileSync(path.join(staged, 'extra.js'), 'extra'); expect(spawnSync(process.execPath, [tool, 'verify', staged, manifest]).status).not.toBe(0);
    rmSync(path.join(staged, 'extra.js')); writeFileSync(path.join(staged, 'a.js'), 'two'); expect(spawnSync(process.execPath, [tool, 'verify', staged, manifest]).status).not.toBe(0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it('binds a source dependency closure while resolving only contained relative links', () => {
    const fixture = path.join('/tmp', `claude-mem-dependency-source-${process.pid}-${Date.now()}`);
    const source = path.join(fixture, 'source');
    const manifest = path.join(fixture, 'manifest.json');
    const tool = path.join(root, 'scripts/dependency-tree-manifest.cjs');
    mkdirSync(source, { recursive: true });
    try {
      writeFileSync(path.join(source, 'a.js'), 'one');
      symlinkSync('a.js', path.join(source, 'alias'));
      expect(spawnSync(process.execPath, [tool, 'capture-source', source, manifest]).status).toBe(0);
      expect(spawnSync(process.execPath, [tool, 'verify-source', source, manifest]).status).toBe(0);
      writeFileSync(path.join(source, 'a.js'), 'two');
      expect(spawnSync(process.execPath, [tool, 'verify-source', source, manifest]).status).not.toBe(0);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it('rejects symlinks, dangling links, and FIFOs in dependency trees', () => {
    const fixture = path.join('/tmp', `claude-mem-dependency-tree-entries-${process.pid}-${Date.now()}`);
    const source = path.join(fixture, 'source'); const manifest = path.join(fixture, 'manifest.json');
    const tool = path.join(root, 'scripts/dependency-tree-manifest.cjs'); mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, 'ordinary.js'), 'ordinary');
    expect(spawnSync(process.execPath, [tool, 'create', source, manifest]).status).toBe(0);
    const cases = [
      ['external-link', path.join(fixture, 'outside.txt')],
      ['internal-link', path.join(source, 'ordinary.js')],
      ['dangling-link', path.join(fixture, 'missing.txt')],
    ] as const;
    writeFileSync(path.join(fixture, 'outside.txt'), 'outside');
    for (const [name, target] of cases) {
      symlinkSync(target, path.join(source, name));
      const run = spawnSync(process.execPath, [tool, 'verify', source, manifest], { encoding: 'utf8' });
      expect(run.status).not.toBe(0); expect(run.stderr).toContain('symlink');
      rmSync(path.join(source, name));
    }
    const fifo = path.join(source, 'named-pipe');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const fifoRun = spawnSync(process.execPath, [tool, 'verify', source, manifest], { encoding: 'utf8' });
    expect(fifoRun.status).not.toBe(0); expect(fifoRun.stderr).toContain('non-regular');
    rmSync(fixture, { recursive: true, force: true });
  });

  it('rejects scoped Phase-1A approval before any installer state or staging path is touched', () => {
    const fixture = path.join('/tmp', `claude-mem-scoped-upgrade-${process.pid}-${Date.now()}`);
    const home = path.join(fixture, 'home');
    const data = path.join(fixture, 'data');
    const run = spawnSync('bash', [scriptPath, 'install'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_MEM_APPROVAL_SCOPE: 'phase-1a',
        CLAUDE_MEM_UPGRADE_HOME: home,
        CLAUDE_MEM_DATA_DIR: data,
        CLAUDE_MEM_UPGRADE_SKIP_CHECKS: '1',
      },
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('scoped Phase-1A approval is non-deploying');
    for (const untouched of [
      home,
      data,
      path.join(data, '.maintained-upgrade.lock'),
      path.join(data, 'release-window-v1.json'),
      path.join(data, 'release-transaction-v1.json'),
      path.join(data, 'backups'),
      path.join(home, '.claude/plugins/marketplaces/thedotmack'),
    ]) expect(existsSync(untouched)).toBe(false);
    rmSync(fixture, { recursive: true, force: true });
  });

  it('keeps full approval on the managed installer path', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const fullManifest = source.indexOf('full) manifest=');
    const scopedGuard = source.indexOf('scoped Phase-1A approval is non-deploying');
    const installerLock = source.indexOf('installer_lock="$data_dir/.maintained-upgrade.lock"');
    expect(fullManifest).toBeGreaterThan(-1);
    expect(scopedGuard).toBeGreaterThan(fullManifest);
    expect(installerLock).toBeGreaterThan(scopedGuard);
  });

  it('does not create a plugin target during a validated dry run', () => {
    const fakeHome = '/tmp/claude-mem-upgrade-nonexistent-home';
    const run = spawnSync('bash', [scriptPath, 'dry-run'], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, CLAUDE_MEM_UPGRADE_HOME: fakeHome, CLAUDE_MEM_UPGRADE_SKIP_CHECKS: '1' },
    });
    expect(run.status).toBe(0);
    expect(() => readFileSync(`${fakeHome}/.claude/plugins/marketplaces/thedotmack`, 'utf8')).toThrow();
  });

  it('rollback stops and verifies the worker before restoring any durable state', () => {
    const source = readFileSync(scriptPath, 'utf8');
    // Backup payloads must contain bytes, not inherited development symlinks.
    // The known upstream openclaw link resolves into the marketplace plugin;
    // cp -aL makes that effective payload self-contained and restore-safe.
    expect(source).toContain('cp -aL -- "$target" "$backup_dir/targets/$key"');
    const rollback = source.slice(source.indexOf('rollback() {'), source.indexOf('\n}\n\nhealth_json='));
    const stop = rollback.indexOf('stop_worker ||');
    expect(stop).toBeGreaterThan(0);
    for (const restore of ['rm -rf -- "$target"', 'settings.json" "$data_dir/settings.json', 'restore_database ||', 'rm -rf -- "$data_dir/chroma']) {
      expect(rollback.indexOf(restore)).toBeGreaterThan(stop);
    }
    expect(rollback.indexOf('start_and_verify_version')).toBeGreaterThan(rollback.indexOf('rm -rf -- "$data_dir/chroma'));
    expect(rollback.indexOf('rolling_back')).toBeLessThan(stop);
    const restoreDb = source.slice(source.indexOf('restore_database() {'), source.indexOf('\n}\nrollback() {'));
    const restoreSidecars = restoreDb.indexOf('rm -f -- "$data_dir/claude-mem.db-wal" "$data_dir/claude-mem.db-shm"');
    const restoreDatabase = restoreDb.indexOf('mv -f -- "$rollback_db_stage" "$data_dir/claude-mem.db"');
    const releaseFailed = rollback.lastIndexOf('release-window.cjs" fail');
    expect(restoreDb.indexOf('validate_sqlite_snapshot "$rollback_db_stage"')).toBeGreaterThan(0);
    expect(restoreSidecars).toBeGreaterThan(restoreDb.indexOf('validate_sqlite_snapshot "$rollback_db_stage"'));
    expect(restoreDatabase).toBeGreaterThan(restoreSidecars);
    expect(releaseFailed).toBeGreaterThan(restoreDatabase);
    const releaseSequence = source.slice(source.indexOf('node "$repo_dir/scripts/release-window.cjs" begin'));
    expect(releaseSequence.indexOf('hooks_drained')).toBeLessThan(releaseSequence.indexOf('stop_worker'));
    expect(releaseSequence.indexOf('stop_worker')).toBeLessThan(releaseSequence.indexOf('worker_quiesced'));
    const install = source.slice(source.indexOf('old_version='));
    expect(install.indexOf('stop_worker')).toBeLessThan(install.indexOf('cp -a "$data_dir/chroma"'));
    expect(install.indexOf('mkdir -p "$(dirname "$target")"')).toBeLessThan(install.indexOf('mktemp -d'));
    expect(source).toContain('runtime_root="$(dirname "$staged_bundle")/.."');
    expect(source).toContain("--exclude='node_modules'");
    expect(source).toContain('dependency-tree-manifest.cjs" create "$repo_dir/node_modules"');
    expect(source).toContain('dependency-tree-manifest.cjs" verify "$stage/node_modules"');
    expect(source).toContain('external manifest digest changed before install');
    expect(source).toContain('ui/viewer.html');
    expect(source).toContain('skills/how-it-works/onboarding-explainer.md');
    expect(source).toContain('.claude/plugins/cache/thedotmack/claude-mem/$expected_version/scripts/worker-service.cjs');
    expect(source).toContain("path.join(target, '.install-version')");
    expect(source).toContain('write_install_marker "$home_dir/.claude/plugins/marketplaces/thedotmack"');
    expect(source).toContain('write_install_marker "$home_dir/.codex/plugins/cache/claude-mem-local/claude-mem/$expected_version"');
    expect(source).toContain('worker did not fully stop; refusing state restore');
    expect(source).toContain('kill -0 "$running_pid"');
    expect(source).toContain('validate_sqlite_snapshot "$rollback_db_stage"');
    expect(source).toContain('database-snapshot-state');
    expect(source).toContain('snapshot_complete=0');
    expect(source).toContain('trap on_failure ERR');
    expect(source).toContain("trap 'on_interrupt 130' INT");
    expect(source).toContain("trap 'on_interrupt 143' TERM");
    expect(source).toContain('write-build-attestation.cjs');
    expect(source).toContain('build-attestation-v1.json');
    expect(source).toContain('release-window.cjs');
    expect(source).toContain('installer_lock="$data_dir/.maintained-upgrade.lock"');
    expect(source).toContain('validate_managed_worker_path "$old_worker_path"');
    expect(source).toContain('worker-service entrypoint');
    expect(source).toContain('"$root/"*/scripts/worker-service.cjs');
    expect(source).toContain('hooks_drained');
    expect(source).toContain('managed_start_token');
    expect(source).toContain('assert_lease_aware_old_worker "$old_worker_path"');
    expect(source.indexOf('assert_lease_aware_old_worker "$old_worker_path"')).toBeLessThan(source.indexOf('release-window.cjs" begin'));
    expect(source).toContain('replacement_started=0');
    expect(source.split('\n').filter((line) => line.includes('ps -g "$running_pgid"') && !line.includes('|| true'))).toHaveLength(0);
    expect(readFileSync(path.join(root, 'scripts/release-window.cjs'), 'utf8')).toContain('canonical-recovery-history-v1');
    expect(source.indexOf('prepare_recovery "$data_dir"')).toBeLessThan(source.indexOf('window_closed "$data_dir"'));
    expect(rollback).toContain('release-transaction.cjs" complete "$data_dir"');
    expect(source.indexOf('reconcile_interrupted_release\nvalidate_source')).toBeGreaterThan(0);
    expect(source.indexOf('reconcile_interrupted_release\nvalidate_source')).toBeLessThan(source.indexOf('release-window.cjs" hooks_attached'));
    // Every paired transaction/window transition commits recovery evidence
    // first, so fault injection between the two writes is recoverable.
    for (const phase of ['snapshot_ready', 'artifact_installed', 'worker_attested', 'hooks_attached']) {
      const receipt = `release-transaction.cjs" phase "$data_dir" ${phase}`;
      const window = `release-window.cjs" ${phase} "$data_dir"`;
      expect(releaseSequence.indexOf(receipt)).toBeLessThan(releaseSequence.indexOf(window));
    }
    const rollbackValidation = rollback.indexOf('prevalidate_reconcile_restore "$backup_dir"');
    expect(rollbackValidation).toBeGreaterThan(0);
    expect(rollbackValidation).toBeLessThan(rollback.indexOf('release-window.cjs" rolling_back'));
    expect(rollbackValidation).toBeLessThan(stop);
  });

  it('drains only the captured worker process group before accepting a stale writer lease', () => {
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toContain('[[ "$running_pgid" == "$running_pid" ]]');
    expect(source).toContain('kill -TERM -- "-$running_pgid"');
    expect(source).toContain('j.pid!==pid||j.startToken!==token||j.dataDir!==dir');
    expect(source).toContain('never touch an unrelated legacy MCP group');
  });

  it('guards every rollback and reconciliation restore destination with canonical parent identity', () => {
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toContain('begin_restore_target()');
    expect(source).toContain('check_restore_target()');
    const reconcile = source.slice(source.indexOf('if [[ "$receipt_phase" == snapshot_ready'), source.indexOf('\n  validate_managed_worker_path "$old_worker_path"'));
    const rollback = source.slice(source.indexOf('rollback() {'), source.indexOf('\n}\n\nhealth_json='));
    for (const body of [reconcile, rollback]) {
      expect(body).toContain('begin_restore_target');
      expect(body).toContain('check_restore_target');
      for (const operation of ['rm -rf --', 'rm -f --', 'cp -a']) expect(body).toContain(operation);
    }
    expect(source.slice(source.indexOf('restore_database() {'), source.indexOf('\n}\nrollback() {'))).toContain('mv -f -- "$rollback_db_stage" "$data_dir/claude-mem.db"');
  });

  it('admits only the root harness setgid agentroot collaboration directories', () => {
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toContain('getent group agentroot');
    expect(source).toContain('"$gid" == 0');
    expect(source).toContain('$((8#$mode & 2000)) -ne 0');
    expect(source).toContain('$((8#$mode & 0002)) -eq 0');
  });

  it('uses an exclusive installer lock in an isolated data fixture', () => {
    const fixture = path.join('/tmp', `claude-mem-upgrade-lock-${process.pid}-${Date.now()}`);
    const lock = path.join(fixture, '.maintained-upgrade.lock');
    // Exercise the same primitive used by the script, without invoking its
    // source/manifest validation or any user-owned path.
    const create = spawnSync('mkdir', ['-p', fixture]);
    expect(create.status).toBe(0);
    expect(spawnSync('mkdir', [lock]).status).toBe(0);
    expect(spawnSync('mkdir', [lock]).status).not.toBe(0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it('takes the reconciliation lock before inspecting a fresh maintenance fence', async () => {
    const fixture = path.join('/tmp', `claude-mem-reconcile-lock-${process.pid}-${Date.now()}`);
    mkdirSync(fixture, { recursive: true });
    const holder = spawn('flock', [path.join(fixture, '.maintained-upgrade.lock'), '-c', 'sleep 10']);
    await Bun.sleep(100);
    writeFileSync(path.join(fixture, 'release-window-v1.json'), JSON.stringify({ schemaVersion: 1, generation: 9, phase: 'worker_quiesced' }));
    const run = spawnSync('bash', [scriptPath, 'reconcile'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_MEM_UPGRADE_HOME: path.join(fixture, 'home'), CLAUDE_MEM_DATA_DIR: fixture, CLAUDE_MEM_UPGRADE_SKIP_CHECKS: '1' } });
    expect(run.status).toBe(4);
    expect(JSON.parse(readFileSync(path.join(fixture, 'release-window-v1.json'), 'utf8')).phase).toBe('worker_quiesced');
    holder.kill('SIGKILL');
    rmSync(fixture, { recursive: true, force: true });
  });

  it('rejects a legacy hook already in flight before creating a maintenance fence', () => {
    const fixture = path.join('/tmp', `claude-mem-legacy-hook-upgrade-${process.pid}-${Date.now()}`);
    const home = path.join(fixture, 'home');
    const data = path.join(fixture, 'data');
    const oldWorker = path.join(home, '.claude/plugins/cache/thedotmack/claude-mem/13.13.0/scripts/worker-service.cjs');
    const inFlight = path.join(fixture, 'legacy-hook-in-flight');
    mkdirSync(path.dirname(oldWorker), { recursive: true });
    // This deliberately lacks the durable lease protocol. It models an old
    // hook process that may still be about to write when an upgrade begins.
    writeFileSync(oldWorker, '/* legacy hook worker: may write after detach */\n');
    writeFileSync(inFlight, 'legacy hook has not been forcibly interrupted\n');
    const run = spawnSync('bash', [scriptPath, 'probe-hook-fence', oldWorker], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_MEM_UPGRADE_HOME: home, CLAUDE_MEM_DATA_DIR: data, CLAUDE_MEM_UPGRADE_SKIP_CHECKS: '1' },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('legacy/non-lease-aware installed hook worker');
    expect(readFileSync(inFlight, 'utf8')).toContain('has not been forcibly interrupted');
    expect(() => readFileSync(path.join(data, 'release-window-v1.json'), 'utf8')).toThrow();
    rmSync(fixture, { recursive: true, force: true });
  });

  it('admits only the exact archived 13.14.0 worker to the one-time legacy bootstrap', () => {
    const archived = '/root/.claude/plugins/cache/thedotmack/claude-mem/13.14.0/scripts/worker-service.cjs';
    if (!existsSync(archived)) return;
    const fixture = path.join('/tmp', `claude-mem-legacy-exact-${process.pid}-${Date.now()}`);
    const home = path.join(fixture, 'home');
    const worker = path.join(home, '.claude/plugins/cache/thedotmack/claude-mem/13.14.0/scripts/worker-service.cjs');
    mkdirSync(path.dirname(worker), { recursive: true });
    writeFileSync(worker, readFileSync(archived));
    const run = spawnSync('bash', [scriptPath, 'probe-hook-fence', worker], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_MEM_UPGRADE_HOME: home, CLAUDE_MEM_DATA_DIR: path.join(fixture, 'data'), CLAUDE_MEM_UPGRADE_SKIP_CHECKS: '1' } });
    expect(run.status).toBe(0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it('attests a healthy replacement before hook attachment and explicitly reconciles the closed window', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const sequence = source.slice(source.lastIndexOf('new_worker_path='));
    expect(sequence.indexOf('start_and_verify_version')).toBeLessThan(sequence.indexOf('hooks_attached "$data_dir"'));
    expect(sequence.indexOf('window_closed "$data_dir"')).toBeLessThan(sequence.indexOf('/api/recovery/reconcile-release'));
    expect(sequence.indexOf('start_and_verify_version')).toBeLessThan(sequence.indexOf('recovery_reconciled'));
    expect(sequence).toContain('replacement worker did not reconcile the release window');
  });

  it('prevalidates corrupt snapshots and malicious old workers before deleting reconciliation targets', () => {
    for (const kind of ['missing-db', 'corrupt-db', 'malicious-worker']) {
      const fixture = path.join('/tmp', `claude-mem-reconcile-prevalidate-${kind}-${process.pid}-${Date.now()}`);
      const backup = path.join(fixture, 'backups', 'receipt'); const home = path.join(fixture, 'home'); const target = path.join(home, '.claude/plugins/cache/thedotmack/claude-mem/13.14.1');
      const presence = path.join(backup, 'presence'); mkdirSync(path.join(backup, 'targets'), { recursive: true }); mkdirSync(path.join(backup, 'metadata'), { recursive: true }); mkdirSync(presence); mkdirSync(target, { recursive: true });
      const mark = (item: string, state = 'absent') => writeFileSync(path.join(presence, require('crypto').createHash('sha256').update(item).digest('hex')), state);
      for (const item of [target, path.join(home, '.claude/plugins/installed_plugins.json'), path.join(home, '.claude/plugins/known_marketplaces.json'), path.join(home, '.claude/settings.json'), path.join(home, '.codex/config.toml'), path.join(home, '.codex/hooks.json'), path.join(home, '.local/bin/claude-mem'), path.join(fixture, 'settings.json'), path.join(fixture, 'build-attestation-v1.json'), path.join(fixture, 'chroma')]) mark(item);
      writeFileSync(path.join(target, 'replacement-asset'), 'must remain behind the fence\n');
      const worker = kind === 'malicious-worker' ? path.join(fixture, 'outside-worker-service.cjs') : path.join(home, '.claude/plugins/cache/thedotmack/claude-mem/13.14.0/scripts/worker-service.cjs');
      mkdirSync(path.dirname(worker), { recursive: true }); writeFileSync(worker, '// worker\n');
      if (kind === 'corrupt-db') { writeFileSync(path.join(backup, 'database-snapshot-state'), 'present\n'); writeFileSync(path.join(backup, 'claude-mem.db'), 'not a sqlite database'); } else if (kind === 'missing-db') writeFileSync(path.join(backup, 'database-snapshot-state'), 'present\n'); else writeFileSync(path.join(backup, 'database-snapshot-state'), 'absent\n');
      writeFileSync(path.join(fixture, 'release-window-v1.json'), JSON.stringify({ schemaVersion: 1, id: 'window', generation: 9, phase: 'snapshot_ready', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hookDrainAcknowledged: true, recoveryBounds: { startedAt: new Date().toISOString() } }));
      writeFileSync(path.join(fixture, 'release-transaction-v1.json'), JSON.stringify({ schemaVersion: 1, id: 'receipt', generation: 9, phase: 'snapshot_ready', backupDir: backup, oldWorkerPath: worker, oldVersion: '13.14.0', quiescedWorkerPid: 999999, targets: [target] }));
      const run = spawnSync('bash', [scriptPath, 'reconcile'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_MEM_UPGRADE_HOME: home, CLAUDE_MEM_DATA_DIR: fixture, CLAUDE_MEM_HEALTH_URL: 'http://127.0.0.1:1/api/health', CLAUDE_MEM_UPGRADE_SKIP_CHECKS: '1' } });
      expect(run.status).not.toBe(0); expect(JSON.parse(readFileSync(path.join(fixture, 'release-window-v1.json'), 'utf8')).phase).toBe('snapshot_ready'); expect(readFileSync(path.join(target, 'replacement-asset'), 'utf8')).toContain('must remain');
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects every interior receipt-backup symlink before reconciliation can restore anything', () => {
    for (const control of ['presence', 'database-snapshot-state', 'targets', 'metadata'] as const) {
      const fixture = path.join('/tmp', `claude-mem-reconcile-backup-link-${control}-${process.pid}-${Date.now()}`);
      const backup = path.join(fixture, 'backups', 'receipt');
      const home = path.join(fixture, 'home');
      const target = path.join(home, '.claude/plugins/cache/thedotmack/claude-mem/13.14.1');
      const presence = path.join(backup, 'presence');
      mkdirSync(path.join(backup, 'targets'), { recursive: true });
      mkdirSync(path.join(backup, 'metadata'), { recursive: true });
      mkdirSync(presence);
      const markAbsent = (item: string) => writeFileSync(path.join(presence, require('crypto').createHash('sha256').update(item).digest('hex')), 'absent');
      for (const item of [target, path.join(home, '.claude/plugins/installed_plugins.json'), path.join(home, '.claude/plugins/known_marketplaces.json'), path.join(home, '.claude/settings.json'), path.join(home, '.codex/config.toml'), path.join(home, '.codex/hooks.json'), path.join(home, '.local/bin/claude-mem'), path.join(fixture, 'settings.json'), path.join(fixture, 'build-attestation-v1.json'), path.join(fixture, 'chroma')]) markAbsent(item);
      writeFileSync(path.join(backup, 'database-snapshot-state'), 'absent\n');
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, 'replacement-asset'), 'must remain behind the fence\n');
      const oldWorker = path.join(home, '.claude/plugins/cache/thedotmack/claude-mem/13.14.0/scripts/worker-service.cjs');
      mkdirSync(path.dirname(oldWorker), { recursive: true });
      writeFileSync(oldWorker, '// fake managed worker\n');
      const external = path.join(fixture, `external-${control}`);
      if (control === 'database-snapshot-state') {
        writeFileSync(external, 'absent\n');
        rmSync(path.join(backup, control));
      } else {
        mkdirSync(external);
        if (control === 'presence') for (const entry of require('fs').readdirSync(presence)) writeFileSync(path.join(external, entry), readFileSync(path.join(presence, entry)));
        rmSync(path.join(backup, control), { recursive: true, force: true });
      }
      symlinkSync(external, path.join(backup, control));
      const window = { schemaVersion: 1, id: 'window', generation: 9, phase: 'snapshot_ready', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hookDrainAcknowledged: true, recoveryBounds: { startedAt: new Date().toISOString() } };
      writeFileSync(path.join(fixture, 'release-window-v1.json'), JSON.stringify(window));
      writeFileSync(path.join(fixture, 'release-transaction-v1.json'), JSON.stringify({ schemaVersion: 1, id: 'receipt', generation: 9, phase: 'snapshot_ready', backupDir: backup, oldWorkerPath: oldWorker, oldVersion: '13.14.0', quiescedWorkerPid: 999999, targets: [target] }));
      const run = spawnSync('bash', [scriptPath, 'reconcile'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_MEM_UPGRADE_HOME: home, CLAUDE_MEM_DATA_DIR: fixture, CLAUDE_MEM_HEALTH_URL: 'http://127.0.0.1:1/api/health', CLAUDE_MEM_UPGRADE_SKIP_CHECKS: '1' } });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('reconciliation backup contains a symlink');
      expect(JSON.parse(readFileSync(path.join(fixture, 'release-window-v1.json'), 'utf8')).phase).toBe('snapshot_ready');
      expect(readFileSync(path.join(target, 'replacement-asset'), 'utf8')).toContain('must remain');
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects dangerous destructive roots before it can inspect or mutate a target filesystem', () => {
    const run = spawnSync('bash', [scriptPath, 'dry-run'], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, CLAUDE_MEM_UPGRADE_HOME: '/', CLAUDE_MEM_DATA_DIR: '/tmp/claude-mem-upgrade-test-data', CLAUDE_MEM_UPGRADE_SKIP_CHECKS: '1' },
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('unsafe home root: /');
  });

  it('fresh-shell reconciliation resumes worker_quiesced before the ordinary manifest gate', () => {
    expectFreshShellReconciliation('worker_quiesced');
  });

  it('fresh-shell reconciliation rolls back snapshot_ready before the ordinary manifest gate', () => {
    expectFreshShellReconciliation('snapshot_ready');
  });

  it('fresh-shell reconciliation rolls back artifact_installed before the ordinary manifest gate', () => {
    expectFreshShellReconciliation('artifact_installed');
  });

  it('fresh-shell reconciliation rolls back worker_attested before the ordinary manifest gate', () => {
    expectFreshShellReconciliation('worker_attested');
  });

  it('fresh-shell reconciliation rolls back hooks_attached before the ordinary manifest gate', () => {
    expectFreshShellReconciliation('hooks_attached');
  });

  it('fails closed on an untrusted writer lease before fresh reconciliation restores or starts anything', () => {
    const fixture = path.join('/tmp', `claude-mem-reconcile-writer-lease-${process.pid}-${Date.now()}`);
    const backup = path.join(fixture, 'backups', 'receipt');
    const home = path.join(fixture, 'home');
    const target = path.join(home, '.claude/plugins/cache/thedotmack/claude-mem/13.14.1');
    const presence = path.join(backup, 'presence');
    const markAbsent = (item: string) => writeFileSync(path.join(presence, require('crypto').createHash('sha256').update(item).digest('hex')), 'absent');
    mkdirSync(path.join(backup, 'targets'), { recursive: true });
    mkdirSync(path.join(backup, 'metadata'), { recursive: true });
    mkdirSync(presence);
    writeFileSync(path.join(backup, 'database-snapshot-state'), 'absent\n');
    for (const item of [target, path.join(home, '.claude/plugins/installed_plugins.json'), path.join(home, '.claude/plugins/known_marketplaces.json'), path.join(home, '.claude/settings.json'), path.join(home, '.codex/config.toml'), path.join(home, '.codex/hooks.json'), path.join(home, '.local/bin/claude-mem'), path.join(fixture, 'settings.json'), path.join(fixture, 'build-attestation-v1.json'), path.join(fixture, 'chroma')]) markAbsent(item);
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'replacement-asset'), 'must remain behind the fence\n');
    mkdirSync(path.join(fixture, 'chroma'), { recursive: true });
    writeFileSync(path.join(fixture, 'chroma', '.claude-mem-chroma-writer.lock'), '{"owner":"unknown-or-stale"}\n');
    const window = { schemaVersion: 1, id: 'window', generation: 9, phase: 'snapshot_ready', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hookDrainAcknowledged: true, recoveryBounds: { startedAt: new Date().toISOString() } };
    writeFileSync(path.join(fixture, 'release-window-v1.json'), JSON.stringify(window));
    writeFileSync(path.join(fixture, 'release-transaction-v1.json'), JSON.stringify({ schemaVersion: 1, id: 'receipt', generation: 9, phase: 'snapshot_ready', backupDir: backup, oldWorkerPath: path.join(home, '.claude/plugins/cache/thedotmack/claude-mem/13.14.0/scripts/worker-service.cjs'), oldVersion: '13.14.0', quiescedWorkerPid: 999999, targets: [target] }));
    const run = spawnSync('bash', [scriptPath, 'reconcile'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_MEM_UPGRADE_HOME: home, CLAUDE_MEM_DATA_DIR: fixture, CLAUDE_MEM_HEALTH_URL: 'http://127.0.0.1:1/api/health', CLAUDE_MEM_UPGRADE_SKIP_CHECKS: '1' } });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('writer lease is present or untrusted');
    expect(JSON.parse(readFileSync(path.join(fixture, 'release-window-v1.json'), 'utf8')).phase).toBe('snapshot_ready');
    expect(readFileSync(path.join(target, 'replacement-asset'), 'utf8')).toContain('must remain');
    rmSync(fixture, { recursive: true, force: true });
  });

  it('fails closed on a missing receipt and leaves an active maintenance fence intact', () => {
    const fixture = path.join('/tmp', `claude-mem-reconcile-missing-${process.pid}-${Date.now()}`);
    mkdirSync(fixture, { recursive: true });
    const window = { schemaVersion: 1, id: 'window', generation: 9, phase: 'worker_quiesced', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hookDrainAcknowledged: true, recoveryBounds: { startedAt: new Date().toISOString() } };
    writeFileSync(path.join(fixture, 'release-window-v1.json'), JSON.stringify(window));
    const run = spawnSync('bash', [scriptPath, 'reconcile'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_MEM_UPGRADE_HOME: `${fixture}/home`, CLAUDE_MEM_DATA_DIR: fixture, CLAUDE_MEM_HEALTH_URL: 'http://127.0.0.1:1/api/health', CLAUDE_MEM_UPGRADE_SKIP_CHECKS: '1' } });
    expect(run.status).not.toBe(0);
    expect(JSON.parse(readFileSync(path.join(fixture, 'release-window-v1.json'), 'utf8')).phase).toBe('worker_quiesced');
    rmSync(fixture, { recursive: true, force: true });
  });

  it('fails closed on an invalid receipt and leaves its active maintenance fence intact', () => {
    const fixture = path.join('/tmp', `claude-mem-reconcile-invalid-${process.pid}-${Date.now()}`);
    mkdirSync(fixture, { recursive: true });
    const window = { schemaVersion: 1, id: 'window', generation: 9, phase: 'worker_quiesced', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hookDrainAcknowledged: true, recoveryBounds: { startedAt: new Date().toISOString() } };
    writeFileSync(path.join(fixture, 'release-window-v1.json'), JSON.stringify(window));
    writeFileSync(path.join(fixture, 'release-transaction-v1.json'), '{not json}\n');
    const run = spawnSync('bash', [scriptPath, 'reconcile'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_MEM_UPGRADE_HOME: `${fixture}/home`, CLAUDE_MEM_DATA_DIR: fixture, CLAUDE_MEM_HEALTH_URL: 'http://127.0.0.1:1/api/health', CLAUDE_MEM_UPGRADE_SKIP_CHECKS: '1' } });
    expect(run.status).not.toBe(0);
    expect(JSON.parse(readFileSync(path.join(fixture, 'release-window-v1.json'), 'utf8')).phase).toBe('worker_quiesced');
    rmSync(fixture, { recursive: true, force: true });
  });

  it('accepts only an older terminal receipt and reclaims a dead, old legacy lease', () => {
    const fixture = path.join('/tmp', `claude-mem-reconcile-compat-${process.pid}-${Date.now()}`);
    const home = path.join(fixture, 'home'); const data = path.join(fixture, 'data');
    const backup = path.join(data, 'backups', 'old-receipt'); const worker = path.join(home, '.claude/plugins/cache/thedotmack/claude-mem/13.23.1/scripts/worker-service.cjs');
    mkdirSync(backup, { recursive: true }); mkdirSync(path.dirname(worker), { recursive: true }); writeFileSync(worker, '// approved old worker\n');
    // The compatibility receipt is deliberately historical. Pin its directory
    // timestamp so coarse filesystem clocks cannot classify it as evidence
    // created just after the new release window began.
    utimesSync(backup, new Date(0), new Date(0));
    const startedAt = new Date().toISOString(); const hash = require('crypto').createHash('sha256').update(readFileSync(worker)).digest('hex');
    const hooksDetachedAt = startedAt;
    const window = { schemaVersion: 1, id: 'window', generation: 3, phase: 'hooks_detached', startedAt, updatedAt: hooksDetachedAt, hooksDetachedAt, hookDrainAcknowledged: false, oldArtifactSha256: hash, recoveryBounds: { startedAt } };
    writeFileSync(path.join(data, 'release-window-v1.json'), JSON.stringify(window));
    writeFileSync(path.join(data, 'release-transaction-v1.json'), JSON.stringify({ schemaVersion: 1, id: 'old', generation: 2, phase: 'complete', backupDir: backup, oldWorkerPath: worker, oldVersion: '13.23.1', quiescedWorkerPid: 999999, targets: [] }));
    const leases = path.join(data, 'release-hook-leases-v1'); mkdirSync(leases); const legacy = path.join(leases, 'dead.json');
    writeFileSync(legacy, JSON.stringify({ schemaVersion: 1, pid: 999999, acquiredAt: '2020-01-01T00:00:00.000Z' })); utimesSync(legacy, new Date(0), new Date(0));
    const bin = path.join(fixture, 'bin'); mkdirSync(bin); const curl = path.join(bin, 'curl');
    writeFileSync(curl, `#!/usr/bin/env bash\nprintf '%s' ${JSON.stringify(JSON.stringify({ status: 'ok', version: '13.23.1', workerPath: worker }))}\n`); chmodSync(curl, 0o755);
    const run = spawnSync('bash', [scriptPath, 'reconcile'], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_MEM_UPGRADE_HOME: home, CLAUDE_MEM_DATA_DIR: data, CLAUDE_MEM_HEALTH_URL: 'http://127.0.0.1:1/api/health', CLAUDE_MEM_UPGRADE_SKIP_CHECKS: '1' } });
    expect(run.status).toBe(0); expect(JSON.parse(readFileSync(path.join(data, 'release-window-v1.json'), 'utf8')).phase).toBe('recovery_reconciled'); expect(existsSync(legacy)).toBe(false);
    for (const [generation, phase] of [[2, 'worker_quiesced'], [4, 'complete']] as const) {
      const bad = path.join(fixture, `${generation}-${phase}`); mkdirSync(path.join(bad, 'backups', 'r'), { recursive: true });
      writeFileSync(path.join(bad, 'release-window-v1.json'), JSON.stringify({ ...window, generation: 3, phase: 'hooks_detached' }));
      writeFileSync(path.join(bad, 'release-transaction-v1.json'), JSON.stringify({ schemaVersion: 1, id: 'r', generation, phase, backupDir: path.join(bad, 'backups', 'r'), oldWorkerPath: worker, oldVersion: '13.23.1', quiescedWorkerPid: 999999, targets: [] }));
      const rejected = spawnSync('bash', [scriptPath, 'reconcile'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_MEM_UPGRADE_HOME: home, CLAUDE_MEM_DATA_DIR: bad, CLAUDE_MEM_HEALTH_URL: 'http://127.0.0.1:1/api/health', CLAUDE_MEM_UPGRADE_SKIP_CHECKS: '1' } });
      expect(rejected.status).not.toBe(0); rmSync(bad, { recursive: true, force: true });
    }
    rmSync(fixture, { recursive: true, force: true });
  });

  it('pins all tracked behavior/security files and an approved worker bundle', () => {
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const manifest = JSON.parse(readFileSync(path.join(root, `maintained-patches/nvidia-recovery-v${version}.json`), 'utf8'));
    expect(manifest.expectedFileCount).toBe(Object.keys(manifest.files).length);
    expect(manifest.expectedFileCount).toBeGreaterThanOrEqual(68);
    expect(manifest.approvedBundleSha256).toMatch(/^[a-f0-9]{64}$/);
    for (const protectedPath of [
      'src/services/infrastructure/WorktreeAdoption.ts',
      'tests/npx-cli/provider-account-gate.test.ts',
      'tests/worker/sync/mutation-sites.test.ts',
    ]) expect(manifest.files[protectedPath]).toMatch(/^[a-f0-9]{64}$/);

    const upstreamDiff = spawnSync(
      'git',
      ['diff', '--name-only', manifest.upstreamCommit, '--', 'src', 'tests'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(upstreamDiff.status).toBe(0);
    const unreviewed = upstreamDiff.stdout.trim().split('\n').filter(Boolean)
      .filter((file: string) => !(file in manifest.files));
    expect(unreviewed).toEqual([]);
  });
});
