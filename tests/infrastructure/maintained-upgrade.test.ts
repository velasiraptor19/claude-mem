import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';

const root = path.resolve(import.meta.dir, '../..');
const scriptPath = path.join(root, 'scripts/maintained-upgrade.sh');

describe('maintained upgrade safety', () => {
  it('dry-run plans creation of missing Claude and Codex targets without touching them', () => {
    const fakeHome = '/tmp/claude-mem-upgrade-nonexistent-home';
    const run = spawnSync('bash', [scriptPath, 'dry-run'], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, CLAUDE_MEM_UPGRADE_HOME: fakeHome, CLAUDE_MEM_UPGRADE_SKIP_CHECKS: '1' },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`${fakeHome}/.claude/plugins/marketplaces/thedotmack`);
    expect(run.stdout).toContain(`${fakeHome}/.codex/plugins/cache/claude-mem-local/claude-mem/13.13.1`);
    expect(run.stdout).toContain('create-or-replace');
  });

  it('rollback stops and verifies the worker before restoring any durable state', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const rollback = source.slice(source.indexOf('rollback() {'), source.indexOf('\n}\n\nold_version='));
    const stop = rollback.indexOf('stop_worker ||');
    expect(stop).toBeGreaterThan(0);
    for (const restore of ['rm -rf -- "$target"', 'settings.json" "$data_dir/settings.json', 'claude-mem.db" "$data_dir/claude-mem.db', 'rm -rf -- "$data_dir/chroma']) {
      expect(rollback.indexOf(restore)).toBeGreaterThan(stop);
    }
    expect(rollback.indexOf('start_and_verify_version')).toBeGreaterThan(rollback.indexOf('rm -rf -- "$data_dir/chroma'));
    const install = source.slice(source.indexOf('old_version='));
    expect(install.indexOf('stop_worker')).toBeLessThan(install.indexOf('cp -a "$data_dir/chroma"'));
    expect(install.indexOf('mkdir -p "$(dirname "$target")"')).toBeLessThan(install.indexOf('mktemp -d'));
    expect(source).toContain('runtime_root="$(dirname "$staged_bundle")/.."');
    expect(source).toContain("--exclude='node_modules'");
    expect(source).toContain('rsync -aL --delete "$repo_dir/node_modules/" "$stage/node_modules/"');
    expect(source).toContain('ui/viewer.html');
    expect(source).toContain('skills/how-it-works/onboarding-explainer.md');
    expect(source).toContain('.claude/plugins/cache/thedotmack/claude-mem/$expected_version/scripts/worker-service.cjs');
    expect(source).toContain("path.join(target, '.install-version')");
    expect(source).toContain('write_install_marker "$home_dir/.claude/plugins/marketplaces/thedotmack"');
    expect(source).toContain('write_install_marker "$home_dir/.codex/plugins/cache/claude-mem-local/claude-mem/$expected_version"');
    expect(source).toContain('worker did not fully stop; refusing state restore');
    expect(source).toContain('kill -0 "$old_worker_pid"');
  });

  it('pins all tracked behavior/security files and an approved worker bundle', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'maintained-patches/nvidia-recovery-v13.13.1.json'), 'utf8'));
    expect(Object.keys(manifest.files)).toHaveLength(57);
    expect(manifest.approvedBundleSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
