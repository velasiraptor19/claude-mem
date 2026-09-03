#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$repo_dir/maintained-patches/nvidia-recovery-v13.13.0.json"
mode="${1:-verify}"
home_dir="${CLAUDE_MEM_UPGRADE_HOME:-$HOME}"
data_dir="${CLAUDE_MEM_DATA_DIR:-$home_dir/.claude-mem}"
health_url="${CLAUDE_MEM_HEALTH_URL:-http://127.0.0.1:37700/api/health}"
shutdown_url="${health_url%/api/health}/api/admin/shutdown"
cd "$repo_dir"

json_field() { node -e "console.log(require(process.argv[1])[process.argv[2]])" "$manifest" "$1"; }
expected_version="$(json_field upstreamVersion)"
expected_commit="$(json_field upstreamCommit)"
expected_bundle="$(json_field approvedBundleSha256)"
actual_version="$(node -p "require('./package.json').version")"
base_commit="$(git merge-base HEAD "$expected_commit")"
[[ "$actual_version" == "$expected_version" && "$base_commit" == "$expected_commit" ]] || { echo "Unsupported upstream" >&2; exit 2; }

node - "$manifest" <<'NODE'
const fs=require('fs'), crypto=require('crypto'); const m=require(process.argv[2]);
if(Object.keys(m.files).length!==50) throw new Error(`manifest must cover exactly 50 tracked files, got ${Object.keys(m.files).length}`);
for (const [f,want] of Object.entries(m.files)) { if(!fs.existsSync(f)) throw new Error(`manifest file missing: ${f}`); const got=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); if(got!==want) throw new Error(`manifest hash mismatch: ${f}`); }
NODE
[[ "$(sha256sum plugin/scripts/worker-service.cjs | cut -d' ' -f1)" == "$expected_bundle" ]] || { echo "approved bundle hash mismatch" >&2; exit 3; }

if [[ "${CLAUDE_MEM_UPGRADE_SKIP_CHECKS:-0}" != 1 ]]; then bun run typecheck; bun test tests; git diff --check; fi
if [[ "$mode" == verify ]]; then
  exit 0
fi
if [[ "$mode" == dry-run ]]; then
  echo "PLAN stop worker and verify health endpoint is unreachable"
  echo "PLAN backup DB Chroma settings and existing plugin targets"
  echo "PLAN create-or-replace $home_dir/.claude/plugins/marketplaces/thedotmack from approved staging"
  echo "PLAN create-or-replace $home_dir/.codex/plugins/cache/claude-mem-local/claude-mem/$expected_version from approved staging"
  echo "PLAN verify approved bundle hash $expected_bundle then start $expected_version"
  echo "PLAN rollback stops/verifies worker before restore, starts/verifies old version"
  exit 0
fi
[[ "$mode" == install ]] || { echo "usage: $0 [verify|dry-run|install]" >&2; exit 2; }

backup_dir="$data_dir/backups/maintained-upgrade-$(date +%Y%m%d-%H%M%S)"
targets=(
  "$home_dir/.claude/plugins/marketplaces/thedotmack"
  "$home_dir/.claude/plugins/cache/thedotmack/claude-mem/$expected_version"
  "$home_dir/.codex/plugins/cache/claude-mem-local/claude-mem/$expected_version"
)
metadata_files=(
  "$home_dir/.claude/plugins/installed_plugins.json"
  "$home_dir/.claude/plugins/known_marketplaces.json"
)
mkdir -p "$backup_dir/targets"
mkdir -p "$backup_dir/metadata"

stop_worker() {
  curl -fsS --max-time 2 -X POST "$shutdown_url" >/dev/null 2>&1 || npx claude-mem stop >/dev/null 2>&1 || true
  for _ in {1..20}; do curl -fsS --max-time 1 "$health_url" >/dev/null 2>&1 || return 0; sleep 0.25; done
  echo "worker did not stop; refusing state restore" >&2; return 1
}
start_and_verify_version() {
  local want="$1" worker_script="$2"
  bun "$worker_script" start >/dev/null
  for _ in {1..40}; do
    if curl -fsS --max-time 1 "$health_url" 2>/dev/null | node -e 'const path=require("path");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s),same=path.resolve(j.workerPath)===path.resolve(process.argv[2]);process.exit(j.status==="ok"&&j.version===process.argv[1]&&same?0:1)}catch{process.exit(1)}})' "$want" "$worker_script"; then return 0; fi
    sleep 0.25
  done
  return 1
}
rollback() {
  set +e
  stop_worker || { echo "ROLLBACK ABORTED: new worker still reachable; backups left at $backup_dir" >&2; return 1; }
  if [[ "${install_started:-0}" == 1 ]]; then
    for target in "${targets[@]}"; do
      key="$(printf %s "$target" | sha256sum | cut -d' ' -f1)"
      rm -rf -- "$target"
      if [[ -d "$backup_dir/targets/$key" ]]; then mkdir -p "$(dirname "$target")"; cp -a "$backup_dir/targets/$key" "$target"; fi
    done
  fi
  for metadata in "${metadata_files[@]}"; do
    key="$(printf %s "$metadata" | sha256sum | cut -d' ' -f1)"
    [[ -f "$backup_dir/metadata/$key" ]] && cp -a "$backup_dir/metadata/$key" "$metadata"
  done
  [[ -f "$backup_dir/settings.json" ]] && cp -a "$backup_dir/settings.json" "$data_dir/settings.json"
  [[ -f "$backup_dir/claude-mem.db" ]] && cp -a "$backup_dir/claude-mem.db" "$data_dir/claude-mem.db"
  if [[ -d "$backup_dir/chroma" ]]; then rm -rf -- "$data_dir/chroma"; cp -a "$backup_dir/chroma" "$data_dir/chroma"; fi
  start_and_verify_version "$(cat "$backup_dir/old-version")" "$(cat "$backup_dir/old-worker-path")" || echo "old worker failed health verification" >&2
}

health_json="$(curl -fsS --max-time 2 "$health_url")"
old_version="$(printf '%s' "$health_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
old_worker_path="$(printf '%s' "$health_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).workerPath))')"
printf '%s\n' "$old_version" > "$backup_dir/old-version"
printf '%s\n' "$old_worker_path" > "$backup_dir/old-worker-path"
install_started=0
stop_worker
trap rollback ERR
[[ -f "$data_dir/settings.json" ]] && cp -a "$data_dir/settings.json" "$backup_dir/"
if [[ -f "$data_dir/claude-mem.db" ]]; then AUDIT_DB="$backup_dir/claude-mem.db" bun -e 'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1],{readonly:true}); db.run(`VACUUM INTO ${JSON.stringify(process.env.AUDIT_DB)}`); db.close()' "$data_dir/claude-mem.db"; fi
[[ -d "$data_dir/chroma" ]] && cp -a "$data_dir/chroma" "$backup_dir/"
for target in "${targets[@]}"; do key="$(printf %s "$target" | sha256sum | cut -d' ' -f1)"; [[ -d "$target" ]] && cp -a "$target" "$backup_dir/targets/$key"; done
for metadata in "${metadata_files[@]}"; do key="$(printf %s "$metadata" | sha256sum | cut -d' ' -f1)"; [[ -f "$metadata" ]] && cp -a "$metadata" "$backup_dir/metadata/$key"; done

for target in "${targets[@]}"; do
  mkdir -p "$(dirname "$target")"
  stage="$(mktemp -d "$(dirname "$target")/.claude-mem-stage.XXXXXX")"
  if [[ "$target" == "$home_dir/.claude/plugins/marketplaces/thedotmack" ]]; then
    rsync -a --delete --exclude='.git' "$repo_dir/" "$stage/"
    [[ -d "$target/.git" ]] && cp -a "$target/.git" "$stage/.git"
    staged_bundle="$stage/plugin/scripts/worker-service.cjs"
  else
    rsync -a --delete "$repo_dir/plugin/" "$stage/"
    staged_bundle="$stage/scripts/worker-service.cjs"
  fi
  runtime_root="$(dirname "$staged_bundle")/.."
  [[ -f "$runtime_root/package.json" && -f "$runtime_root/ui/viewer.html" && -f "$runtime_root/skills/how-it-works/onboarding-explainer.md" ]] || { echo "staged runtime assets missing: $runtime_root" >&2; false; }
  [[ "$(sha256sum "$staged_bundle" | cut -d' ' -f1)" == "$expected_bundle" ]] || { echo "staged bundle hash mismatch" >&2; false; }
  install_started=1
  rm -rf -- "$target"; mv "$stage" "$target"
done

# Keep the official installer contract intact after atomic replacement. Doctor
# validates these markers, and future repair/update flows use them to decide
# whether the runtime is current.
bun_version="$(bun --version)"
uv_version="$(uv --version)"
write_install_marker() {
  MARKER_TARGET="$1" EXPECTED_VERSION="$expected_version" BUN_VERSION="$bun_version" UV_VERSION="$uv_version" node <<'NODE'
const fs = require('fs');
const path = require('path');
const target = process.env.MARKER_TARGET;
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, '.install-version'), JSON.stringify({
  version: process.env.EXPECTED_VERSION,
  bun: process.env.BUN_VERSION,
  uv: process.env.UV_VERSION,
  installedAt: new Date().toISOString(),
}));
NODE
}
write_install_marker "$home_dir/.claude/plugins/marketplaces/thedotmack"
write_install_marker "$home_dir/.claude/plugins/marketplaces/thedotmack/plugin"
write_install_marker "$home_dir/.claude/plugins/cache/thedotmack/claude-mem/$expected_version"
write_install_marker "$home_dir/.codex/plugins/cache/claude-mem-local/claude-mem/$expected_version"
installed_plugins="$home_dir/.claude/plugins/installed_plugins.json"
if [[ -f "$installed_plugins" ]]; then
  INSTALLED_PLUGINS="$installed_plugins" EXPECTED_VERSION="$expected_version" HOME_DIR="$home_dir" node <<'NODE'
const fs = require('fs');
const file = process.env.INSTALLED_PLUGINS;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const entries = data?.plugins?.['claude-mem@thedotmack'];
if (!Array.isArray(entries) || entries.length === 0) throw new Error('claude-mem install metadata missing');
const now = new Date().toISOString();
for (const entry of entries) {
  entry.installPath = `${process.env.HOME_DIR}/.claude/plugins/cache/thedotmack/claude-mem/${process.env.EXPECTED_VERSION}`;
  entry.version = process.env.EXPECTED_VERSION;
  entry.lastUpdated = now;
}
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(tmp, file);
NODE
fi
new_worker_path="$home_dir/.claude/plugins/cache/thedotmack/claude-mem/$expected_version/scripts/worker-service.cjs"
start_and_verify_version "$expected_version" "$new_worker_path"
trap - ERR
echo "Installed and verified; backup: $backup_dir"
