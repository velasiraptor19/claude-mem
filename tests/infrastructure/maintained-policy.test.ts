import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const root = path.resolve(import.meta.dir, '../..');
const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
const runbook = readFileSync(path.join(root, 'docs/maintained/UPGRADE_RUNBOOK.md'), 'utf8');
const history = readFileSync(path.join(root, 'docs/maintained/UPGRADE_HISTORY.md'), 'utf8');
const customizations = readFileSync(path.join(root, 'docs/maintained/CUSTOMIZATIONS.md'), 'utf8');
const upstreamChanges = readFileSync(path.join(root, 'docs/maintained/UPSTREAM_13.14_TO_13.24.md'), 'utf8');

describe('maintained repository policy', () => {
  test('binds agents to the canonical maintained documents', () => {
    for (const name of ['UPGRADE_RUNBOOK.md', 'UPGRADE_HISTORY.md', 'CUSTOMIZATIONS.md', 'UPSTREAM_13.14_TO_13.24.md']) {
      expect(agents).toContain(name);
    }
  });

  test('preserves release and data-safety invariants', () => {
    expect(agents).toMatch(/hook'lar kalıcı biçimde\s+ayrılmış ve drain edilmiş/);
    expect(agents).toContain("Yayın fence'ini asla atlama");
    expect(agents).toContain("SQLite/Chroma'yı doğrudan değiştirme");
    expect(agents).toMatch(/ilgisiz legacy MCP\s+sürecini öldürme/);
    expect(runbook.indexOf('hooks_detached')).toBeLessThan(runbook.indexOf('call shutdown'));
    expect(runbook).toContain('maintained-upgrade.sh reconcile');
  });

  test('keeps evidence, project identity, and opt-in boundaries explicit', () => {
    expect(agents).toContain('Mantıksal hafıza projesi `claude-mem`dir');
    expect(agents).toContain("Git diff'leri");
    expect(agents).toContain('açık kullanıcı onayı gerektirir');
    expect(history).toContain('Başarılı 13.24.0 terfisi — generation 18');
    expect(customizations).toContain('Canonical Codex transcript recovery');
    expect(customizations).toContain('Subagent-aware capture');
    expect(upstreamChanges).toContain("Upstream'in hâlâ karşılamadığı alanlar");
    expect(upstreamChanges).toContain('13.24.0');
  });

  test('reports the maintained delta against upstream at the same version', () => {
    const report = spawnSync('node', [path.join(root, 'scripts/maintained-diff-report.cjs'), root], { encoding: 'utf8' });
    expect(report.status).toBe(0);
    const parsed = JSON.parse(report.stdout);
    expect(parsed.version).toBe(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version);
    expect(parsed.upstreamRef).toBe(`archive/upstream-v${parsed.version}`);
    expect(parsed.changedFiles).toBeGreaterThan(90);
    expect(parsed.files.some((entry: { path: string }) => entry.path === 'src/services/worker/NvidiaProvider.ts')).toBe(true);
    expect(parsed.files.some((entry: { path: string }) => entry.path === 'AGENTS.md')).toBe(true);
  });
});
