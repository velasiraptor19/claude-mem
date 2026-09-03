#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
approval_scope="${CLAUDE_MEM_APPROVAL_SCOPE:-full}"
case "$approval_scope" in
  full) manifest="$repo_dir/maintained-patches/nvidia-recovery-v13.14.0.json" ;;
  phase-1a) manifest="$repo_dir/maintained-patches/phase-1a-release-hook-recovery-v1.json" ;;
  *) echo "unsupported approval scope: $approval_scope" >&2; exit 2 ;;
esac

# Phase-1A approval is deliberately limited to source attestation.  It must
# never authorize this managed installer: even its lock and reconciliation
# paths mutate durable state before an installation begins.
if [[ "$approval_scope" == "phase-1a" ]]; then
  echo "scoped Phase-1A approval is non-deploying; use a full approval manifest for managed upgrades" >&2
  exit 2
fi

mode="${1:-verify}"
home_dir="${CLAUDE_MEM_UPGRADE_HOME:-$HOME}"
data_dir="${CLAUDE_MEM_DATA_DIR:-$home_dir/.claude-mem}"
health_url="${CLAUDE_MEM_HEALTH_URL:-http://127.0.0.1:37700/api/health}"
shutdown_url="${health_url%/api/health}/api/admin/shutdown"
cd "$repo_dir"

# All destructive destinations are derived from these two roots. Resolve
# lexical traversal before constructing them and reject filesystem roots (and
# their common aliases) so an accidental environment override cannot turn an
# installer operation into a broad deletion.
canonical_path() { realpath -m -- "$1"; }
reject_dangerous_root() {
  case "$1" in /|/tmp|/var|/usr|/etc|/home) echo "unsafe $2 root: $1" >&2; exit 2;; esac
}
home_dir="$(canonical_path "$home_dir")"
data_dir="$(canonical_path "$data_dir")"
[[ "$home_dir" == /* && "$data_dir" == /* && "$home_dir" != "$data_dir" ]] || { echo "home and data directories must be distinct absolute paths" >&2; exit 2; }
reject_dangerous_root "$home_dir" home
reject_dangerous_root "$data_dir" data

# Destructive paths must remain below a configured root *and* may not traverse
# a symlinked existing component.  realpath -m is only lexical; accepting it
# alone would let "$home_dir/.claude" point outside the approved tree.
assert_symlink_safe_target() {
  local target="$1" root="$2" current remainder component
  [[ "$target" == "$(canonical_path "$target")" ]] || { echo "target contains traversal: $target" >&2; return 1; }
  [[ "$target" == "$root/"* ]] || { echo "target escapes approved root: $target" >&2; return 1; }
  [[ ! -L "$root" ]] || { echo "refusing symlinked approved root: $root" >&2; return 1; }
  current="${root%/}"
  remainder="${target#"$current"/}"
  while [[ -n "$remainder" ]]; do
    component="${remainder%%/*}"
    remainder="${remainder#"$component"}"
    remainder="${remainder#/}"
    current="$current/$component"
    [[ ! -L "$current" ]] || { echo "refusing symlinked destructive path component: $current" >&2; return 1; }
  done
}

assert_target_root() {
  local target="$1"
  if [[ "$target" == "$data_dir/"* ]]; then assert_symlink_safe_target "$target" "$data_dir"
  elif [[ "$target" == "$home_dir/"* ]]; then assert_symlink_safe_target "$target" "$home_dir"
  else echo "target outside configured roots: $target" >&2; return 1; fi
}

# The same lock covers the early fresh-process reconciliation and a following
# install.  A second shell must not inspect or mutate the same fence while the
# first shell is deciding whether it is safe to recover it.
installer_lock="$data_dir/.maintained-upgrade.lock"
acquire_operation_lock() {
  assert_target_root "$installer_lock" || return 1
  mkdir -p "$data_dir" || return 1
  [[ ! -L "$data_dir" ]] || { echo "refusing symlinked data root: $data_dir" >&2; return 1; }
  if ! mkdir "$installer_lock" 2>/dev/null; then
    echo "another maintained upgrade owns $installer_lock" >&2; return 4
  fi
  trap 'rmdir -- "$installer_lock" 2>/dev/null || true' EXIT
}
acquire_operation_lock || exit $?

json_field() { node -e "console.log(require(process.argv[1])[process.argv[2]])" "$manifest" "$1"; }
validate_source() {
expected_version="$(json_field upstreamVersion)"
expected_commit="$(json_field upstreamCommit)"
expected_bundle="$(json_field approvedBundleSha256)"
actual_version="$(node -p "require('./package.json').version")"
base_commit="$(git merge-base HEAD "$expected_commit")"
[[ "$actual_version" == "$expected_version" && "$base_commit" == "$expected_commit" ]] || { echo "Unsupported upstream" >&2; return 2; }
node "$repo_dir/scripts/verify-approved-manifest.cjs" --manifest "$manifest" --bundle "$repo_dir/plugin/scripts/worker-service.cjs" --repo "$repo_dir" --mode "$approval_scope" >/dev/null || return 3
}

verify_writer_lease_released() {
  local writer_lease="$data_dir/chroma/.claude-mem-chroma-writer.lock"
  assert_target_root "$writer_lease" || return 1
  # A fresh reconciler has no process identity with which to classify a lease.
  # Treat every durable lease, including one that looks stale, as ownership
  # that cannot be safely displaced.  An operator must resolve it explicitly.
  [[ ! -e "$writer_lease" && ! -L "$writer_lease" ]]
}

validate_managed_worker_path() {
  local candidate="$1" resolved root
  [[ -f "$candidate" && ! -L "$candidate" ]] || { echo "health worker path is not a regular file" >&2; return 1; }
  [[ "$(basename "$candidate")" == worker-service.cjs ]] || { echo "health worker path is not a worker-service entrypoint" >&2; return 1; }
  resolved="$(realpath -e -- "$candidate")" || return 1
  for root in "$home_dir/.claude/plugins/cache/thedotmack/claude-mem" "$home_dir/.codex/plugins/cache/claude-mem-local/claude-mem"; do
    root="$(realpath -m -- "$root")"
    [[ "$resolved" == "$root/"*/scripts/worker-service.cjs ]] && return 0
  done
  root="$(realpath -m -- "$home_dir/.claude/plugins/marketplaces/thedotmack/plugin")"
  [[ "$resolved" == "$root/scripts/worker-service.cjs" ]] && return 0
  echo "health worker path is outside managed roots: $resolved" >&2; return 1
}

# A release-window fence only drains handlers that acquired its on-disk lease.
# Older plugin workers predate that protocol, so a logical fence alone cannot
# prove that one of their already-dispatched hooks will not write after the
# replacement starts. Do not guess from the version number: require the
# installed artifact itself to contain all protocol operations used by the
# current implementation. This is deliberately a strict compatibility gate,
# not a best-effort fallback.
assert_lease_aware_old_worker() {
  local worker="$1"
  validate_managed_worker_path "$worker" || return 1
  if ! grep -Fq 'release-hook-leases-v1' "$worker" \
    || ! grep -Fq 'tryAcquireHookLease' "$worker" \
    || ! grep -Fq 'acknowledgeHookDrainAfterLeases' "$worker"; then
    echo "legacy/non-lease-aware installed hook worker; refusing unsafe upgrade before detach" >&2
    return 1
  fi
}
validate_sqlite_snapshot() {
  local snapshot="$1"
  bun -e 'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1],{readonly:true}); try { const integrity=db.query("PRAGMA integrity_check").values(); const foreignKeys=db.query("PRAGMA foreign_key_check").values(); if(integrity.length!==1 || integrity[0][0]!=="ok" || foreignKeys.length!==0) process.exit(1); } finally { db.close(); }' "$snapshot"
}
reconcile_snapshot_state() {
  local backup="$1" path="$2" key state
  key="$(printf %s "$path" | sha256sum | cut -d' ' -f1)"
  state="$(cat "$backup/presence/$key")" || return 1
  [[ "$state" == present || "$state" == absent ]] || return 1
  printf '%s' "$state"
}
assert_reconcile_backup_tree_has_no_symlinks() {
  local backup="$1" link
  # Reconciliation later removes and recreates destinations from this tree.
  # Validate every component up front, including unused metadata, so an
  # apparently absent receipt entry cannot leave an interior link unchecked.
  link="$(find -P "$backup" -type l -print -quit)" || return 1
  [[ -z "$link" ]] || { echo "reconciliation backup contains a symlink: $link" >&2; return 1; }
}
prevalidate_reconcile_restore() {
  local backup="$1" worker="$2" target_json="$3" target item key state db_state
  local -a restore_targets
  assert_target_root "$backup" || return 1
  [[ "$backup" == "$data_dir/backups/"* && "$backup" == "$(canonical_path "$backup")" && -d "$backup" && ! -L "$backup" ]] || return 1
  assert_reconcile_backup_tree_has_no_symlinks "$backup" || return 1
  mapfile -t restore_targets < <(node -e 'for(const t of JSON.parse(process.argv[1])) console.log(t)' "$target_json")
  ((${#restore_targets[@]} > 0)) || return 1
  for target in "${restore_targets[@]}"; do
    [[ "$target" == "$home_dir/"* ]] || return 1
    assert_target_root "$target" || return 1
    state="$(reconcile_snapshot_state "$backup" "$target")" || return 1
    key="$(printf %s "$target" | sha256sum | cut -d' ' -f1)"
    [[ "$state" == absent || ( -d "$backup/targets/$key" && ! -L "$backup/targets/$key" ) ]] || return 1
  done
  for item in "$home_dir/.claude/plugins/installed_plugins.json" "$home_dir/.claude/plugins/known_marketplaces.json" "$data_dir/settings.json" "$data_dir/build-attestation-v1.json" "$data_dir/chroma"; do
    assert_target_root "$item" || return 1
    state="$(reconcile_snapshot_state "$backup" "$item")" || return 1
    key="$(printf %s "$item" | sha256sum | cut -d' ' -f1)"
    if [[ "$state" == present ]]; then
      if [[ "$item" == "$data_dir/chroma" ]]; then [[ -d "$backup/chroma" && ! -L "$backup/chroma" ]] || return 1
      elif [[ "$item" == "$data_dir/"* ]]; then [[ -f "$backup/$(basename "$item")" && ! -L "$backup/$(basename "$item")" ]] || return 1
      else [[ -f "$backup/metadata/$key" && ! -L "$backup/metadata/$key" ]] || return 1; fi
    fi
  done
  db_state="$(cat "$backup/database-snapshot-state")" || return 1
  case "$db_state" in present) [[ -f "$backup/claude-mem.db" && ! -L "$backup/claude-mem.db" ]] && validate_sqlite_snapshot "$backup/claude-mem.db" || return 1;; absent) ;; *) return 1;; esac
  validate_managed_worker_path "$worker"
}

reconcile_interrupted_release() {
  # Reconciliation deliberately runs before source/manifest validation: an
  # interrupted maintenance fence must be handled even when a later checkout
  # is no longer a valid installer source.
  local plan receipt_phase receipt_generation receipt_pid window_phase window_generation lease_dir backup_dir old_worker_path old_version target phase operation key item state start_auth receipt_targets_json
  # No window means there is no fence to reconcile. A terminal window is
  # likewise not an interruption; its receipt is historical evidence only.
  [[ -e "$data_dir/release-window-v1.json" ]] || return 0
  read -r window_phase window_generation < <(node - "$data_dir/release-window-v1.json" <<'NODE'
const fs=require('fs'); const w=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if (!w || w.schemaVersion !== 1 || !Number.isSafeInteger(w.generation) || w.generation < 1 || typeof w.phase !== 'string') process.exit(1);
console.log(w.phase, w.generation);
NODE
) || { echo "release window is unreadable; preserving maintenance fence" >&2; return 1; }
  [[ "$window_phase" != recovery_reconciled && "$window_phase" != failed ]] || return 0
  plan="$(node "$repo_dir/scripts/release-transaction.cjs" reconcile "$data_dir")" || return 1
  read -r operation receipt_phase receipt_generation receipt_pid backup_dir old_worker_path old_version < <(printf '%s' "$plan" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s),r=j.receipt;if(!r||!(["resume_snapshot","rollback"].includes(j.operation))||!Number.isSafeInteger(r.generation)||!Number.isSafeInteger(r.quiescedWorkerPid)||typeof r.backupDir!=="string"||typeof r.oldWorkerPath!=="string"||typeof r.oldVersion!=="string")process.exit(1); console.log([j.operation,r.phase,r.generation,r.quiescedWorkerPid,r.backupDir,r.oldWorkerPath,r.oldVersion].join("\t"))}catch{process.exit(1)}})') || return 1
  # Transaction state is committed before the matching window state.  Thus a
  # crash may leave the window one (or more, after retries) durable steps
  # behind its receipt, but never ahead.  That receipt is sufficient to take
  # the conservative rollback branch; reject every other relationship.
  [[ "$window_generation" == "$receipt_generation" ]] || { echo "receipt/window generation mismatch; preserving maintenance fence" >&2; return 1; }
  if ! node - "$window_phase" "$receipt_phase" <<'NODE'
const rank = { prepared: 0, hooks_detached: 1, hooks_drained: 2, worker_quiesced: 3, snapshot_ready: 4, artifact_installed: 5, worker_attested: 6, hooks_attached: 7, window_closed: 8 };
const [windowPhase, receiptPhase] = process.argv.slice(2);
const receiptRank = receiptPhase === 'complete' ? 8 : rank[receiptPhase];
process.exit(Number.isInteger(rank[windowPhase]) && Number.isInteger(receiptRank) && rank[windowPhase] <= receiptRank ? 0 : 1);
NODE
  then
    echo "receipt is behind or incompatible with window; preserving maintenance fence" >&2; return 1
  fi
  receipt_targets_json="$(printf '%s' "$plan" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).receipt;if(!Array.isArray(r.targets)||r.targets.some(t=>typeof t!=="string"||t.includes("\\n")))process.exit(1);process.stdout.write(JSON.stringify(r.targets))}catch{process.exit(1)}})')" || return 1
  lease_dir="$data_dir/release-hook-leases-v1"
  [[ ! -d "$lease_dir" || -z "$(find "$lease_dir" -maxdepth 1 -type f -name '*.json' -print -quit)" ]] || { echo "active hook lease prevents fresh reconciliation" >&2; return 1; }
  ! kill -0 "$receipt_pid" 2>/dev/null || { echo "quiesced worker PID is still alive; preserving maintenance fence" >&2; return 1; }
  ! curl -fsS --max-time 1 "$health_url" >/dev/null 2>&1 || { echo "unknown running worker prevents fresh reconciliation" >&2; return 1; }
  verify_writer_lease_released || { echo "writer lease is present or untrusted; preserving maintenance fence" >&2; return 1; }
  # The sole resumable point has an already-proven dead worker but no durable
  # snapshot. Complete that idempotent stage, then take the same rollback path
  # as later interruptions. Never continue an install from an unknown shell.
  if [[ "$operation" == resume_snapshot ]]; then
    # Receipt-first ordering can leave the visible window at hooks_drained
    # when a crash follows the durable quiescence receipt.  Its recorded dead
    # PID and generation are the proof needed to advance exactly this missing
    # fence step before taking the idempotent snapshot.
    if [[ "$window_phase" != worker_quiesced ]]; then
      node "$repo_dir/scripts/release-window.cjs" worker_quiesced "$data_dir" >/dev/null || return 1
      window_phase=worker_quiesced
    fi
    assert_target_root "$backup_dir" || return 1
    [[ "$backup_dir" == "$data_dir/backups/"* && "$backup_dir" == "$(canonical_path "$backup_dir")" && ! -L "$backup_dir" ]] || { echo "receipt backup escapes the managed backup root" >&2; return 1; }
    mkdir -p "$backup_dir/targets" "$backup_dir/metadata" "$backup_dir/presence" || return 1
    reconcile_presence() { local p="$1"; local k; k="$(printf %s "$p" | sha256sum | cut -d' ' -f1)"; [[ -e "$p" || -L "$p" ]] && printf present > "$backup_dir/presence/$k" || printf absent > "$backup_dir/presence/$k"; }
    reconcile_presence "$data_dir/settings.json"; reconcile_presence "$data_dir/build-attestation-v1.json"; reconcile_presence "$data_dir/claude-mem.db"; reconcile_presence "$data_dir/chroma"
    [[ ! -e "$data_dir/claude-mem.db-wal" && ! -e "$data_dir/claude-mem.db-shm" ]] || { echo "SQLite sidecars remained after quiescence; preserving maintenance fence" >&2; return 1; }
    [[ -f "$data_dir/settings.json" ]] && cp -a "$data_dir/settings.json" "$backup_dir/"; [[ -f "$data_dir/build-attestation-v1.json" ]] && cp -a "$data_dir/build-attestation-v1.json" "$backup_dir/"
    if [[ -f "$data_dir/claude-mem.db" ]]; then printf present > "$backup_dir/database-snapshot-state"; AUDIT_DB="$backup_dir/claude-mem.db" bun -e 'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1],{readonly:true}); db.run(`VACUUM INTO ${JSON.stringify(process.env.AUDIT_DB)}`); db.close()' "$data_dir/claude-mem.db" || return 1; else printf absent > "$backup_dir/database-snapshot-state"; fi
    [[ -d "$data_dir/chroma" ]] && cp -a "$data_dir/chroma" "$backup_dir/"
    while IFS= read -r target; do [[ -n "$target" && "$target" == "$home_dir/"* ]] || return 1; assert_target_root "$target" || return 1; reconcile_presence "$target"; key="$(printf %s "$target" | sha256sum | cut -d' ' -f1)"; [[ -d "$target" ]] && cp -a "$target" "$backup_dir/targets/$key"; done < <(node -e 'for(const t of JSON.parse(process.argv[1])) console.log(t)' "$receipt_targets_json")
    for item in "$home_dir/.claude/plugins/installed_plugins.json" "$home_dir/.claude/plugins/known_marketplaces.json"; do reconcile_presence "$item"; key="$(printf %s "$item" | sha256sum | cut -d' ' -f1)"; [[ -f "$item" ]] && cp -a "$item" "$backup_dir/metadata/$key"; done
    node "$repo_dir/scripts/release-window.cjs" snapshot_ready "$data_dir" >/dev/null || return 1
    node "$repo_dir/scripts/release-transaction.cjs" phase "$data_dir" snapshot_ready >/dev/null || return 1
    receipt_phase=snapshot_ready
  fi
  prevalidate_reconcile_restore "$backup_dir" "$old_worker_path" "$receipt_targets_json" || { echo "reconciliation backup validation failed; preserving maintenance fence" >&2; return 1; }
  node "$repo_dir/scripts/release-window.cjs" rolling_back "$data_dir" "fresh-process reconciliation" >/dev/null || return 1
  # The receipt remains snapshot_ready throughout the per-target rm/mv loop.
  # Restore its targets from that point onward: this is idempotent before the
  # first mutation and symmetric after any crash inside the loop. Presence
  # files make absence a durable part of the old state, rather than an
  # assumption.
  if [[ "$receipt_phase" == snapshot_ready || "$receipt_phase" == artifact_installed || "$receipt_phase" == worker_attested || "$receipt_phase" == hooks_attached ]]; then
    while IFS= read -r target; do key="$(printf %s "$target" | sha256sum | cut -d' ' -f1)"; state="$(cat "$backup_dir/presence/$key")" || return 1; rm -rf -- "$target" || return 1; [[ "$state" == absent ]] || { mkdir -p "$(dirname "$target")" && cp -a "$backup_dir/targets/$key" "$target"; } || return 1; done < <(node -e 'for(const t of JSON.parse(process.argv[1])) console.log(t)' "$receipt_targets_json")
  fi
  for item in "$home_dir/.claude/plugins/installed_plugins.json" "$home_dir/.claude/plugins/known_marketplaces.json" "$data_dir/settings.json" "$data_dir/build-attestation-v1.json"; do key="$(printf %s "$item" | sha256sum | cut -d' ' -f1)"; state="$(cat "$backup_dir/presence/$key")" || return 1; if [[ "$state" == present ]]; then mkdir -p "$(dirname "$item")"; [[ "$item" == "$data_dir/"* ]] && cp -a "$backup_dir/$(basename "$item")" "$item" || cp -a "$backup_dir/metadata/$key" "$item"; else rm -f -- "$item"; fi; done
  state="$(cat "$backup_dir/database-snapshot-state")" || return 1; rm -f -- "$data_dir/claude-mem.db-wal" "$data_dir/claude-mem.db-shm"; if [[ "$state" == present ]]; then [[ -f "$backup_dir/claude-mem.db" ]] || return 1; cp -a "$backup_dir/claude-mem.db" "$data_dir/claude-mem.db"; elif [[ "$state" == absent ]]; then rm -f -- "$data_dir/claude-mem.db"; else return 1; fi
  key="$(printf %s "$data_dir/chroma" | sha256sum | cut -d' ' -f1)"; state="$(cat "$backup_dir/presence/$key")" || return 1; rm -rf -- "$data_dir/chroma"; [[ "$state" == absent ]] || cp -a "$backup_dir/chroma" "$data_dir/chroma" || return 1
  validate_managed_worker_path "$old_worker_path" || { echo "old worker path is not a managed regular file; preserving fence" >&2; return 1; }
  start_auth="$(node "$repo_dir/scripts/release-window.cjs" authorize_start "$data_dir" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!/^[a-f0-9]{64}$/.test(j.token))process.exit(1);console.log(j.token)})')" || return 1
  CLAUDE_MEM_MANAGED_START_AUTH="$start_auth" bun "$old_worker_path" start >/dev/null || return 1
  for _ in {1..40}; do if curl -fsS --max-time 1 "$health_url" 2>/dev/null | node -e 'const path=require("path");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.exit(j.status==="ok"&&j.version===process.argv[1]&&path.resolve(j.workerPath)===path.resolve(process.argv[2])?0:1)}catch{process.exit(1)}})' "$old_version" "$old_worker_path"; then node "$repo_dir/scripts/release-window.cjs" fail "$data_dir" "fresh-process rollback restored durable state" >/dev/null && node "$repo_dir/scripts/release-transaction.cjs" complete "$data_dir" >/dev/null; printf '%s\n' "$plan"; return 0; fi; sleep 0.25; done
  echo "old worker failed health verification; preserving maintenance fence" >&2; return 1
}

if [[ "$mode" == reconcile ]]; then reconcile_interrupted_release; exit $?; fi
# Read-only capability probe used only by the isolated fixture. It neither
# installs nor refreshes manifests, and it never touches a real host config.
if [[ "$mode" == probe-hook-fence ]]; then
  [[ $# -eq 2 ]] || { echo "usage: $0 probe-hook-fence <installed-worker-service.cjs>" >&2; exit 2; }
  assert_lease_aware_old_worker "$2"
  exit $?
fi
reconcile_interrupted_release
validate_source
if [[ "${CLAUDE_MEM_UPGRADE_SKIP_CHECKS:-0}" != 1 ]]; then bun run typecheck; bun test tests; git diff --check; fi
if [[ "$mode" == verify ]]; then exit 0; fi
if [[ "$mode" == dry-run ]]; then
  echo "PLAN stop worker and verify health endpoint is unreachable"
  echo "PLAN backup DB Chroma settings and existing plugin targets"
  echo "PLAN create-or-replace $home_dir/.claude/plugins/marketplaces/thedotmack from approved staging"
  echo "PLAN create-or-replace $home_dir/.codex/plugins/cache/claude-mem-local/claude-mem/$expected_version from approved staging"
  echo "PLAN verify approved bundle hash $expected_bundle then start $expected_version"
  echo "PLAN rollback stops/verifies worker before restore, starts/verifies old version"
  exit 0
fi
[[ "$mode" == install ]] || { echo "usage: $0 [verify|dry-run|install|reconcile]" >&2; exit 2; }

backup_dir="$data_dir/backups/maintained-upgrade-$(date +%Y%m%d-%H%M%S)-$(node -e 'console.log(require("crypto").randomUUID())')"
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
mkdir -p "$backup_dir/presence"
for target in "${targets[@]}" "${metadata_files[@]}" "$data_dir/settings.json" "$data_dir/build-attestation-v1.json" "$data_dir/claude-mem.db" "$data_dir/claude-mem.db-wal" "$data_dir/claude-mem.db-shm" "$data_dir/chroma"; do
  assert_target_root "$target"
done

presence_key() { printf %s "$1" | sha256sum | cut -d' ' -f1; }
record_presence() { local item="$1" key; key="$(presence_key "$item")"; [[ -e "$item" || -L "$item" ]] && printf '%s\n' present > "$backup_dir/presence/$key" || printf '%s\n' absent > "$backup_dir/presence/$key"; }
was_present() { [[ "$(cat "$backup_dir/presence/$(presence_key "$1")")" == present ]]; }
validate_backup_snapshot() {
  local target metadata key
  for target in "${targets[@]}"; do key="$(presence_key "$target")"; ! was_present "$target" || [[ -d "$backup_dir/targets/$key" ]] || return 1; done
  for metadata in "${metadata_files[@]}"; do key="$(presence_key "$metadata")"; ! was_present "$metadata" || [[ -f "$backup_dir/metadata/$key" ]] || return 1; done
  ! was_present "$data_dir/settings.json" || [[ -f "$backup_dir/settings.json" ]] || return 1
  ! was_present "$data_dir/build-attestation-v1.json" || [[ -f "$backup_dir/build-attestation-v1.json" ]] || return 1
  ! was_present "$data_dir/chroma" || [[ -d "$backup_dir/chroma" ]] || return 1
  [[ "$(cat "$backup_dir/database-snapshot-state")" == absent ]] || validate_sqlite_snapshot "$backup_dir/claude-mem.db"
}
validate_managed_worker_path() {
  local candidate="$1" resolved root
  [[ -f "$candidate" && ! -L "$candidate" ]] || { echo "health worker path is not a regular file" >&2; return 1; }
  [[ "$(basename "$candidate")" == worker-service.cjs ]] || { echo "health worker path is not a worker-service entrypoint" >&2; return 1; }
  resolved="$(realpath -e -- "$candidate")" || return 1
  for root in "$home_dir/.claude/plugins/cache/thedotmack/claude-mem" "$home_dir/.codex/plugins/cache/claude-mem-local/claude-mem"; do
    root="$(realpath -m -- "$root")"
    [[ "$resolved" == "$root/"*/scripts/worker-service.cjs ]] && return 0
  done
  root="$(realpath -m -- "$home_dir/.claude/plugins/marketplaces/thedotmack/plugin")"
  [[ "$resolved" == "$root/scripts/worker-service.cjs" ]] && return 0
  echo "health worker path is outside managed roots: $resolved" >&2; return 1
}

stop_worker() {
  # A rollback can be stopping the newly started worker, whose PID is not the
  # PID captured before installation. Capture and require that *current* PID.
  local running_health running_pid
  running_health="$(curl -fsS --max-time 2 "$health_url")" || { echo "running worker health unavailable; refusing state restore" >&2; return 1; }
  running_pid="$(printf '%s' "$running_health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).pid;if(!Number.isSafeInteger(p)||p<2)process.exit(1);console.log(p)}catch{process.exit(1)}})')" || { echo "running worker PID unavailable; refusing state restore" >&2; return 1; }
  curl -fsS --max-time 2 -X POST "$shutdown_url" >/dev/null 2>&1 || npx claude-mem stop >/dev/null 2>&1 || true
  # The HTTP listener closes before final teardown (including chroma-mcp and
  # its writer lock). Replacing the plugin as soon as the port is free races
  # that teardown, so require the original worker process to be gone as well.
  for _ in {1..60}; do
    if ! curl -fsS --max-time 1 "$health_url" >/dev/null 2>&1 && ! kill -0 "$running_pid" 2>/dev/null; then
      verify_writer_lease_released && { stopped_worker_pid="$running_pid"; return 0; }
      echo "worker process exited but writer lease is still present; refusing state restore" >&2
      return 1
    fi
    sleep 0.25
  done
  echo "worker did not fully stop; refusing state restore" >&2; return 1
}
start_and_verify_version() {
  local want="$1" worker_script="$2" start_auth="$3"
  validate_managed_worker_path "$worker_script" || return 1
  CLAUDE_MEM_MANAGED_START_AUTH="$start_auth" bun "$worker_script" start >/dev/null
  for _ in {1..40}; do
    if curl -fsS --max-time 1 "$health_url" 2>/dev/null | node -e 'const path=require("path");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s),same=path.resolve(j.workerPath)===path.resolve(process.argv[2]);process.exit(j.status==="ok"&&j.version===process.argv[1]&&same?0:1)}catch{process.exit(1)}})' "$want" "$worker_script"; then return 0; fi
    sleep 0.25
  done
  return 1
}
managed_start_token() {
  node "$repo_dir/scripts/release-window.cjs" authorize_start "$data_dir" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!Number.isSafeInteger(j.generation)||!/^[a-f0-9]{64}$/.test(j.token))process.exit(1);console.log(j.token)})'
}
validate_sqlite_snapshot() {
  local snapshot="$1"
  bun -e 'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1],{readonly:true}); try { const integrity=db.query("PRAGMA integrity_check").values(); const foreignKeys=db.query("PRAGMA foreign_key_check").values(); if(integrity.length!==1 || integrity[0][0]!=="ok" || foreignKeys.length!==0) process.exit(1); } finally { db.close(); }' "$snapshot"
}
restore_database() {
  local snapshot_state rollback_db_stage
  snapshot_state="$(cat "$backup_dir/database-snapshot-state")" || return 1
  case "$snapshot_state" in
    present)
      [[ -f "$backup_dir/claude-mem.db" ]] || return 1
      rollback_db_stage="$(mktemp "$data_dir/.claude-mem.db.rollback.XXXXXX")" || return 1
      cp -a "$backup_dir/claude-mem.db" "$rollback_db_stage" || { rm -f -- "$rollback_db_stage"; return 1; }
      # Validate the exact staged file before touching live sidecars or DB.
      validate_sqlite_snapshot "$rollback_db_stage" || { rm -f -- "$rollback_db_stage"; return 1; }
      rm -f -- "$data_dir/claude-mem.db-wal" "$data_dir/claude-mem.db-shm" || return 1
      mv -f -- "$rollback_db_stage" "$data_dir/claude-mem.db" || return 1
      ;;
    absent)
      # The pre-install state had no store; restore that absence, including
      # any sidecars a partially started replacement may have created.
      rm -f -- "$data_dir/claude-mem.db" "$data_dir/claude-mem.db-wal" "$data_dir/claude-mem.db-shm" || return 1
      ;;
    *) return 1 ;;
  esac
}
rollback() {
  local rollback_receipt rollback_start_auth
  [[ "${rollback_started:-0}" == 1 ]] && return 0
  rollback_started=1
  trap - ERR INT TERM
  set +e
  # A rollback is a restore operation, not a best-effort cleanup.  Validate
  # the *whole* durable snapshot before stopping a worker or deleting a
  # replacement path.  This deliberately shares the fresh-process validator:
  # an interior backup symlink, an untrusted target, or bad SQLite sidecars
  # must leave the release fence intact in both paths.
  local rollback_targets_json rollback_old_worker
  rollback_targets_json="$(printf '%s\n' "${targets[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.trim().split("\\n").filter(Boolean))))')"
  rollback_old_worker="$(cat "$backup_dir/old-worker-path" 2>/dev/null)" || { echo "ROLLBACK ABORTED: missing old worker receipt" >&2; return 1; }
  prevalidate_reconcile_restore "$backup_dir" "$rollback_old_worker" "$rollback_targets_json" || { echo "ROLLBACK ABORTED: backup validation failed; maintenance fence remains active" >&2; return 1; }
  # Keep the release fence active while state is restored. Marking it failed
  # first would allow another worker to open the database during this window.
  node "$repo_dir/scripts/release-window.cjs" rolling_back "$data_dir" "rollback in progress" >/dev/null 2>&1 || { echo "ROLLBACK ABORTED: could not establish rollback fence" >&2; return 1; }
  # If we already proved the old worker quiesced and never launched a
  # replacement, there is intentionally no health endpoint to stop.
  if [[ "${replacement_started:-0}" == 1 || "${worker_quiesced:-0}" != 1 ]]; then
    stop_worker || { echo "ROLLBACK ABORTED: running worker was not proven stopped; backups left at $backup_dir" >&2; return 1; }
  fi
  if [[ "${install_started:-0}" == 1 ]]; then
    for target in "${targets[@]}"; do
      key="$(printf %s "$target" | sha256sum | cut -d' ' -f1)"
      assert_target_root "$target" || return 1
      rm -rf -- "$target" || return 1
      if was_present "$target"; then [[ -d "$backup_dir/targets/$key" ]] || return 1; mkdir -p "$(dirname "$target")" || return 1; cp -a "$backup_dir/targets/$key" "$target" || return 1; fi
    done
  fi
  for metadata in "${metadata_files[@]}"; do
    key="$(printf %s "$metadata" | sha256sum | cut -d' ' -f1)"
    if was_present "$metadata"; then [[ -f "$backup_dir/metadata/$key" ]] || return 1; mkdir -p "$(dirname "$metadata")" || return 1; cp -a "$backup_dir/metadata/$key" "$metadata" || return 1; else rm -f -- "$metadata" || return 1; fi
  done
  if was_present "$data_dir/settings.json"; then cp -a "$backup_dir/settings.json" "$data_dir/settings.json" || return 1; else rm -f -- "$data_dir/settings.json" || return 1; fi
  if [[ "${snapshot_complete:-0}" == 1 ]]; then
    restore_database || { echo "ROLLBACK ABORTED: staged SQLite snapshot failed validation or restore" >&2; return 1; }
  fi
  if [[ -f "$backup_dir/build-attestation-v1.json" ]]; then
    cp -a "$backup_dir/build-attestation-v1.json" "$data_dir/build-attestation-v1.json" || return 1
  else
    rm -f -- "$data_dir/build-attestation-v1.json" || return 1
  fi
  assert_target_root "$data_dir/chroma" || return 1
  rm -rf -- "$data_dir/chroma" || return 1
  if was_present "$data_dir/chroma"; then [[ -d "$backup_dir/chroma" ]] || return 1; cp -a "$backup_dir/chroma" "$data_dir/chroma" || return 1; fi
  rollback_start_auth="$(managed_start_token)" || return 1
  replacement_started=1
  if ! start_and_verify_version "$(cat "$backup_dir/old-version")" "$(cat "$backup_dir/old-worker-path")" "$rollback_start_auth"; then
    echo "old worker failed health verification" >&2
    return 1
  else
    rollback_receipt="rollback restored durable state"
  fi
  node "$repo_dir/scripts/release-window.cjs" fail "$data_dir" "$rollback_receipt" >/dev/null 2>&1 || true
}

health_json="$(curl -fsS --max-time 2 "$health_url")"
old_version="$(printf '%s' "$health_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
old_worker_path="$(printf '%s' "$health_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).workerPath))')"
validate_managed_worker_path "$old_worker_path"
assert_lease_aware_old_worker "$old_worker_path"
printf '%s\n' "$old_version" > "$backup_dir/old-version"
printf '%s\n' "$old_worker_path" > "$backup_dir/old-worker-path"
install_started=0
snapshot_complete=0
rollback_started=0
worker_quiesced=0
replacement_started=0
on_failure() {
  local status=$?
  trap - ERR INT TERM
  rollback || true
  exit "$status"
}
on_interrupt() {
  local status="$1"
  trap - ERR INT TERM
  rollback || true
  exit "$status"
}
node "$repo_dir/scripts/release-window.cjs" begin "$data_dir" "$(sha256sum "$old_worker_path" | cut -d' ' -f1)" >/dev/null
# From this point every failure, including hook detach or worker quiescence,
# enters the idempotent rollback path instead of leaving an active fence.
trap on_failure ERR
trap 'on_interrupt 130' INT
trap 'on_interrupt 143' TERM
node "$repo_dir/scripts/release-window.cjs" hooks_detached "$data_dir" >/dev/null
# Hook entrypoints observe the durable fence established above. This explicit
# acknowledgement is the drain barrier: only handlers that entered before
# detachment may finish, and worker shutdown cannot start until they do.
node "$repo_dir/scripts/release-window.cjs" hooks_drained "$data_dir" >/dev/null
stop_worker
release_generation="$(node -e 'const s=require(process.argv[1]); if(!Number.isSafeInteger(s.generation))process.exit(1); console.log(s.generation)' "$data_dir/release-window-v1.json")"
RELEASE_GENERATION="$release_generation" DATA_DIR="$data_dir" BACKUP_DIR="$backup_dir" OLD_WORKER_PATH="$old_worker_path" OLD_VERSION="$old_version" QUIESCED_WORKER_PID="${stopped_worker_pid:-}" TARGETS_JSON="$(printf '%s\n' "${targets[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.trim().split("\n").filter(Boolean))))')" node - <<'NODE'
const { spawnSync } = require('child_process');
const input = JSON.stringify({ generation: Number(process.env.RELEASE_GENERATION), backupDir: process.env.BACKUP_DIR, oldWorkerPath: process.env.OLD_WORKER_PATH, oldVersion: process.env.OLD_VERSION, quiescedWorkerPid: Number(process.env.QUIESCED_WORKER_PID), targets: JSON.parse(process.env.TARGETS_JSON) });
const result = spawnSync(process.execPath, ['scripts/release-transaction.cjs', 'begin', process.env.DATA_DIR, input], { stdio: 'inherit' });
process.exit(result.status ?? 1);
NODE
# The transaction receipt is always durable before its matching window phase.
# A crash can therefore leave the window behind, never ahead of the evidence a
# fresh reconciler needs to choose resume_snapshot or rollback.
node "$repo_dir/scripts/release-window.cjs" worker_quiesced "$data_dir" >/dev/null
worker_quiesced=1
record_presence "$data_dir/settings.json"
record_presence "$data_dir/build-attestation-v1.json"
record_presence "$data_dir/claude-mem.db"
record_presence "$data_dir/claude-mem.db-wal"
record_presence "$data_dir/claude-mem.db-shm"
record_presence "$data_dir/chroma"
# A clean shutdown must checkpoint/remove sidecars.  A VACUUM snapshot is a
# complete replacement DB and must never be paired with pre-upgrade WAL/SHM.
[[ ! -e "$data_dir/claude-mem.db-wal" && ! -e "$data_dir/claude-mem.db-shm" ]] || { echo "SQLite sidecars remained after quiescence; refusing snapshot" >&2; false; }
[[ -f "$data_dir/settings.json" ]] && cp -a "$data_dir/settings.json" "$backup_dir/"
[[ -f "$data_dir/build-attestation-v1.json" ]] && cp -a "$data_dir/build-attestation-v1.json" "$backup_dir/"
if [[ -f "$data_dir/claude-mem.db" ]]; then
  printf '%s\n' present > "$backup_dir/database-snapshot-state"
  AUDIT_DB="$backup_dir/claude-mem.db" bun -e 'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1],{readonly:true}); db.run(`VACUUM INTO ${JSON.stringify(process.env.AUDIT_DB)}`); db.close()' "$data_dir/claude-mem.db"
else
  printf '%s\n' absent > "$backup_dir/database-snapshot-state"
fi
[[ -d "$data_dir/chroma" ]] && cp -a "$data_dir/chroma" "$backup_dir/"
for target in "${targets[@]}"; do key="$(presence_key "$target")"; record_presence "$target"; [[ -d "$target" ]] && cp -a "$target" "$backup_dir/targets/$key"; done
for metadata in "${metadata_files[@]}"; do key="$(presence_key "$metadata")"; record_presence "$metadata"; [[ -f "$metadata" ]] && cp -a "$metadata" "$backup_dir/metadata/$key"; done
validate_backup_snapshot || { echo "backup staging validation failed; refusing replacement" >&2; false; }
node "$repo_dir/scripts/release-transaction.cjs" phase "$data_dir" snapshot_ready >/dev/null
node "$repo_dir/scripts/release-window.cjs" snapshot_ready "$data_dir" >/dev/null
snapshot_complete=1

for target in "${targets[@]}"; do
  assert_target_root "$target"
  mkdir -p "$(dirname "$target")"
  stage="$(mktemp -d "$(dirname "$target")/.claude-mem-stage.XXXXXX")"
  if [[ "$target" == "$home_dir/.claude/plugins/marketplaces/thedotmack" ]]; then
    # Copy dependency contents, never a worktree-local symlink.  A symlink is
    # valid while developing but breaks after the staged marketplace is moved
    # under ~/.claude and causes doctor to report a missing runtime.
    rsync -a --delete --exclude='.git' --exclude='node_modules' "$repo_dir/" "$stage/"
    rsync -aL --delete "$repo_dir/node_modules/" "$stage/node_modules/"
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
node "$repo_dir/scripts/release-transaction.cjs" phase "$data_dir" artifact_installed >/dev/null
node "$repo_dir/scripts/release-window.cjs" artifact_installed "$data_dir" "$expected_bundle" >/dev/null

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
new_start_auth="$(managed_start_token)"
replacement_started=1
start_and_verify_version "$expected_version" "$new_worker_path" "$new_start_auth"
node "$repo_dir/scripts/write-build-attestation.cjs" \
  --manifest "$manifest" \
  --bundle "$new_worker_path" \
  --data-dir "$data_dir" \
  --repo "$repo_dir" \
  --approval-scope "$approval_scope"
node "$repo_dir/scripts/release-transaction.cjs" phase "$data_dir" worker_attested >/dev/null
node "$repo_dir/scripts/release-window.cjs" worker_attested "$data_dir" >/dev/null
node "$repo_dir/scripts/release-transaction.cjs" phase "$data_dir" hooks_attached >/dev/null
node "$repo_dir/scripts/release-window.cjs" hooks_attached "$data_dir" >/dev/null
node "$repo_dir/scripts/release-window.cjs" window_closed "$data_dir" >/dev/null
# Canonical transcript recovery is owned by the restarted root worker.  It
# alone writes the generation/window-bound receipt and advances the fence.
# Never let this installer clear a window_closed fence on its own.
node "$repo_dir/scripts/release-transaction.cjs" complete "$data_dir" >/dev/null
trap - ERR INT TERM
echo "Installed and verified; backup: $backup_dir"
