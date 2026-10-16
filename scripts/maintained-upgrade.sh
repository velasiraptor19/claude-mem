#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_version="$(node -p 'require(process.argv[1]).version' "$repo_dir/package.json")"
approval_scope="${CLAUDE_MEM_APPROVAL_SCOPE:-full}"
case "$approval_scope" in
  full) manifest="$repo_dir/maintained-patches/nvidia-recovery-v${package_version}.json" ;;
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

# Snapshot the effective client descriptors and executable as well as plugin payloads.
metadata_files=(
  "$home_dir/.claude/plugins/installed_plugins.json"
  "$home_dir/.claude/plugins/known_marketplaces.json"
  "$home_dir/.claude/settings.json"
  "$home_dir/.codex/config.toml"
  "$home_dir/.codex/hooks.json"
  "$home_dir/.local/bin/claude-mem"
)

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

# Resolve the nearest existing parent once, then require the complete existing
# path to remain a root-owned, non-group/world-writable directory.  The
# installer runs as root; an untrusted user must not be able to replace a
# parent (or the target) with a symlink between validation and replacement.
secure_mode_owner() {
  local path="$1" mode uid gid trusted_gid
  [[ -e "$path" && ! -L "$path" ]] || return 1
  [[ -d "$path" ]] || return 1
  uid="$(stat -c '%u' -- "$path")" || return 1
  mode="$(stat -c '%a' -- "$path")" || return 1
  gid="$(stat -c '%g' -- "$path")" || return 1
  [[ "$uid" == 0 && $((8#$mode & 0002)) -eq 0 ]] || return 1
  if (( (8#$mode & 0020) != 0 )); then
    trusted_gid="$(getent group agentroot | cut -d: -f3)"
    [[ "$gid" == 0 || ( -n "$trusted_gid" && "$gid" == "$trusted_gid" && $((8#$mode & 2000)) -ne 0 ) ]] || return 1
  fi
}

secure_existing_path() {
  local path="$1" mode uid gid trusted_gid
  [[ -e "$path" && ! -L "$path" ]] || return 1
  uid="$(stat -c '%u' -- "$path")" || return 1
  mode="$(stat -c '%a' -- "$path")" || return 1
  gid="$(stat -c '%g' -- "$path")" || return 1
  [[ "$uid" == 0 && $((8#$mode & 0002)) -eq 0 ]] || return 1
  if (( (8#$mode & 0020) != 0 )); then
    trusted_gid="$(getent group agentroot | cut -d: -f3)"
    [[ "$gid" == 0 || ( -n "$trusted_gid" && "$gid" == "$trusted_gid" && $((8#$mode & 2000)) -ne 0 ) ]] || return 1
  fi
}

resolve_secure_target_parent() {
  local target="$1" parent probe root relative component
  assert_target_root "$target" || return 1
  parent="$(dirname -- "$target")"
  probe="$parent"
  while [[ ! -e "$probe" ]]; do
    [[ ! -L "$probe" ]] || { echo "refusing symlink target parent: $probe" >&2; return 1; }
    probe="$(dirname -- "$probe")"
  done
  [[ ! -L "$probe" ]] || { echo "refusing symlink target parent: $probe" >&2; return 1; }
  TARGET_PARENT="$(realpath -e -- "$probe")" || return 1
  [[ "$TARGET_PARENT" == "$parent" ]] || { echo "target parent is not canonical: $parent" >&2; return 1; }
  root="$home_dir"; [[ "$target" == "$data_dir/"* ]] && root="$data_dir"
  secure_mode_owner "$root" || { echo "target root is not secure: $root" >&2; return 1; }
  if [[ "$TARGET_PARENT" == "$root" ]]; then relative=""; else relative="${TARGET_PARENT#"$root"/}"; fi
  probe="$root"
  while [[ -n "$relative" ]]; do
    component="${relative%%/*}"
    relative="${relative#"$component"}"
    relative="${relative#/}"
    probe="$probe/$component"
    secure_mode_owner "$probe" || { echo "target path component is not secure: $probe" >&2; return 1; }
  done
  secure_mode_owner "$TARGET_PARENT" || { echo "target parent is not secure: $TARGET_PARENT" >&2; return 1; }
  TARGET_PARENT_ID="$(stat -c '%d:%i' -- "$TARGET_PARENT")" || return 1
  [[ ! -L "$target" ]] || { echo "refusing symlink target: $target" >&2; return 1; }
  if [[ -e "$target" ]]; then
    secure_existing_path "$target" || { echo "existing target is not secure: $target" >&2; return 1; }
  fi
}

revalidate_secure_target_parent() {
  local target="$1" current
  [[ -n "${TARGET_PARENT:-}" && -n "${TARGET_PARENT_ID:-}" ]] || return 1
  resolve_secure_target_parent "$target" || return 1
  current="$TARGET_PARENT_ID"
  [[ "$TARGET_PARENT" == "$2" && "$current" == "$3" ]] || { echo "target parent identity changed: $target" >&2; return 1; }
}

begin_restore_target() {
  local target="$1"
  resolve_secure_target_parent "$target" || return 1
  RESTORE_TARGET_PARENT="$TARGET_PARENT"
  RESTORE_TARGET_PARENT_ID="$TARGET_PARENT_ID"
}

check_restore_target() {
  local target="$1"
  revalidate_secure_target_parent "$target" "$RESTORE_TARGET_PARENT" "$RESTORE_TARGET_PARENT_ID" || return 1
  [[ ! -L "$target" ]] || { echo "refusing symlink restore target: $target" >&2; return 1; }
}

run_target_hook() {
  [[ -z "${CLAUDE_MEM_UPGRADE_TEST_HOOK:-}" ]] || "$CLAUDE_MEM_UPGRADE_TEST_HOOK" "$1" "$2"
}

# Before dereferencing a source tree, require each link to be relative,
# non-dangling, and contained by that target's own root. This admits the
# inherited marketplace links while rejecting absolute/escaping links and
# loops before cp can read an unintended tree.
validate_backup_source_tree() {
  local source="$1" link link_target resolved
  [[ -d "$source" ]] || return 0
  while IFS= read -r -d '' link; do
    link_target="$(readlink -- "$link")" || return 1
    [[ "$link_target" != /* ]] || { echo "backup source contains an absolute symlink: $link" >&2; return 1; }
    resolved="$(realpath -e -- "$link")" || { echo "backup source contains a dangling or looping symlink: $link" >&2; return 1; }
    [[ "$resolved" == "$source" || "$resolved" == "$source/"* ]] || { echo "backup source symlink escapes target: $link" >&2; return 1; }
  done < <(find -P "$source" -type l -print0)
}

# The same lock covers the early fresh-process reconciliation and a following
# install.  A second shell must not inspect or mutate the same fence while the
# first shell is deciding whether it is safe to recover it.
installer_lock="$data_dir/.maintained-upgrade.lock"
acquire_operation_lock() {
  assert_target_root "$installer_lock" || return 1
  mkdir -p "$data_dir" || return 1
  [[ ! -L "$data_dir" ]] || { echo "refusing symlinked data root: $data_dir" >&2; return 1; }
  exec {installer_lock_fd}>"$installer_lock"
  if ! flock -n "$installer_lock_fd"; then
    echo "another maintained upgrade owns $installer_lock" >&2; return 4
  fi
  trap 'flock -u "$installer_lock_fd" 2>/dev/null || true' EXIT
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
if [[ "$mode" == install ]]; then
  [[ "${CLAUDE_MEM_APPROVED_MANIFEST_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || { echo "install requires externally approved CLAUDE_MEM_APPROVED_MANIFEST_SHA256" >&2; return 3; }
  [[ "$(sha256sum "$manifest" | cut -d' ' -f1)" == "$CLAUDE_MEM_APPROVED_MANIFEST_SHA256" ]] || { echo "external manifest digest does not match candidate" >&2; return 3; }
fi
}

verify_writer_lease_released() {
  local writer_lease="$data_dir/chroma/.claude-mem-chroma-writer.lock"
  assert_target_root "$writer_lease" || return 1
  # A fresh reconciler has no process identity with which to classify a lease.
  # Treat every durable lease, including one that looks stale, as ownership
  # that cannot be safely displaced.  An operator must resolve it explicitly.
  [[ ! -e "$writer_lease" && ! -L "$writer_lease" ]]
}

# A crash before transaction begin leaves no restore payload.  In that narrow
# window the only safe recovery is to prove that the original 13.23.1 worker
# is still serving the exact artifact recorded by the release fence, then
# write an auditable no-op abort receipt.  Hook leases with a start identity
# may be reaped only when their owner is definitely dead or its PID was reused.
reconcile_no_receipt_window() {
  local phase generation started_at expected_hash detach_at historical_complete health worker worker_hash lease file pid token current lease_json lease_mtime now_epoch created_ms mtime_epoch mtime_ms detach_epoch detach_ms
  phase="$1"; generation="$2"; started_at="$3"; expected_hash="$4"; detach_at="${5:-}"
  if [[ "$phase" == hooks_detached || "$phase" == hooks_drained ]]; then
    [[ -n "$detach_at" ]] || { echo "legacy hook lease reconciliation requires a persisted hooks-detached timestamp" >&2; return 1; }
    detach_ms="$(node -e 'const n=Date.parse(process.argv[1]); if(!Number.isFinite(n))process.exit(1); process.stdout.write(String(n))' "$detach_at" 2>/dev/null || echo invalid)"
    [[ "$detach_ms" =~ ^[0-9]+$ ]] || { echo "persisted hooks-detached timestamp is malformed" >&2; return 1; }
    [[ "$detach_ms" -le "$(date +%s%3N)" ]] || { echo "persisted hooks-detached timestamp is in the future" >&2; return 1; }
  fi
  historical_complete="${6:-0}"
  [[ "$phase" == prepared || "$phase" == hooks_detached || "$phase" == hooks_drained ]] || { echo "no-receipt reconciliation unsupported from $phase" >&2; return 1; }
  [[ "$expected_hash" =~ ^[a-f0-9]{64}$ ]] || { echo "release window has no valid original artifact hash" >&2; return 1; }
  health="$(curl -fsS --max-time 2 "$health_url")" || { echo "original worker health unavailable; preserving maintenance fence" >&2; return 1; }
  worker="$(printf '%s' "$health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j.status!=="ok"||j.version!=="13.23.1"||typeof j.workerPath!=="string")process.exit(1);process.stdout.write(j.workerPath)}catch{process.exit(1)}})')" || return 1
  validate_managed_worker_path "$worker" || return 1
  worker_hash="$(sha256sum "$worker" | cut -d' ' -f1)"
  [[ "$worker_hash" == "$expected_hash" ]] || { echo "running worker artifact differs from release-window original" >&2; return 1; }
  # Any backup created or touched after the window began is evidence that the
  # transaction crossed its snapshot boundary; never treat that as a no-op.
  if [[ -d "$data_dir/backups" ]] && find "$data_dir/backups" -mindepth 1 -newermt "$started_at" -print -quit | grep -q .; then
    echo "backup evidence exists for interrupted release generation" >&2; return 1
  fi
  lease_dir="$data_dir/release-hook-leases-v1"
  if [[ -d "$lease_dir" ]]; then
    assert_target_root "$lease_dir" || return 1
    [[ ! -L "$lease_dir" ]] || { echo "hook lease directory is unsafe" >&2; return 1; }
    secure_mode_owner "$lease_dir" || { echo "hook lease directory is not secure" >&2; return 1; }
    while IFS= read -r file; do
      assert_target_root "$file" || { echo "hook lease path is unsafe" >&2; return 1; }
      [[ -f "$file" && ! -L "$file" ]] || { echo "hook lease is not a regular file" >&2; return 1; }
      secure_existing_path "$file" || { echo "hook lease file is not secure" >&2; return 1; }
      lease_json="$(node -e '
const fs=require("fs"), j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
if(!j || j.schemaVersion!==1 || !Number.isSafeInteger(j.pid) || j.pid<2) process.exit(1);
if(j.startToken !== undefined && typeof j.startToken !== "string") process.exit(1);
const createdAt=j.createdAt ?? j.acquiredAt;
if(typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) process.exit(1);
if(Date.parse(createdAt)>Date.now()) process.exit(1);
process.stdout.write(JSON.stringify({pid:j.pid,startToken:j.startToken,createdAt}));' "$file")" || { echo "hook lease is malformed or lacks a valid PID/timestamp" >&2; return 1; }
      pid="$(printf '%s' "$lease_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).pid))')"
      token="$(printf '%s' "$lease_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(typeof j.startToken==="string")process.stdout.write(j.startToken)})')"
      if [[ -n "$token" ]]; then
        current="$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)"
        if [[ -n "$current" && "$current" == "$token" ]]; then echo "active hook lease prevents reconciliation" >&2; return 1; fi
        # Preserve the existing startToken behavior: a missing or changed token
        # proves the recorded incarnation is gone or the PID was reused.
        rm -f -- "$file" || return 1
      else
        # Legacy leases have no process incarnation proof.  Reclaim only after
        # an explicit ESRCH probe and an independently old/expired lease age.
        local kill_status=0
        kill -0 "$pid" 2>/dev/null || kill_status=$?
        if [[ "$kill_status" -eq 0 ]]; then echo "active legacy hook lease prevents reconciliation" >&2; return 1; fi
        [[ "$kill_status" -eq 1 ]] || { echo "legacy hook lease PID is unverifiable" >&2; return 1; }
        # kill(0) reports both ESRCH and EPERM as status 1 in a shell.  Require
        # the Linux process entry to be absent as the independent ESRCH proof;
        # an existing but unreadable /proc entry is live/unverifiable.
        [[ ! -e "/proc/$pid" ]] || { echo "legacy hook lease PID is live or unverifiable" >&2; return 1; }
        mtime_ms="$(node -e 'const fs=require("fs"); const n=fs.statSync(process.argv[1]).mtimeMs; if(!Number.isFinite(n))process.exit(1); process.stdout.write(String(Math.floor(n)))' "$file" 2>/dev/null || echo invalid)" || return 1
        [[ "$mtime_ms" =~ ^[0-9]+$ ]] || { echo "legacy hook lease mtime is malformed" >&2; return 1; }
        [[ "$mtime_ms" -le "$(date +%s%3N)" ]] || { echo "legacy hook lease mtime is in the future" >&2; return 1; }
        created_ms="$(printf '%s' "$lease_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const n=Date.parse(j.createdAt);process.stdout.write(String(n))})')"
        if [[ "$phase" == hooks_detached || "$phase" == hooks_drained ]]; then
          [[ "$mtime_ms" -le "$detach_ms" && "$created_ms" -le "$detach_ms" ]] || { echo "legacy hook lease was created after hook detachment" >&2; return 1; }
        else
          echo "legacy hook lease cannot be reclaimed before hook detachment" >&2; return 1
        fi
        rm -f -- "$file" || return 1
      fi
    done < <(find "$lease_dir" -maxdepth 1 -name '*.json' -print)
  fi
  if [[ "$historical_complete" == 1 ]]; then
    node "$repo_dir/scripts/release-window.cjs" reconcile_noop "$data_dir" "pre-snapshot historical receipt reconciliation generation $generation" >/dev/null || return 1
    echo '{"operation":"historical-complete","result":"recovery_reconciled"}'
    return 0
  fi
  node "$repo_dir/scripts/release-transaction.cjs" abort "$data_dir" "$(node -e 'console.log(JSON.stringify({generation:Number(process.argv[1]),reason:"pre-snapshot no-op reconciliation: original 13.23.1 worker verified"}))' "$generation")" >/dev/null || return 1
  node "$repo_dir/scripts/release-window.cjs" reconcile_noop "$data_dir" "pre-snapshot no-op reconciliation generation $generation" >/dev/null || return 1
  echo '{"operation":"abort","result":"recovery_reconciled"}'
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

LEGACY_13_14_WORKER_SHA256='13b7070cf7202d83731bbd12d382374e9eef043cdf6b60b88ac99b429c04a123'
legacy_bootstrap=0
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
    if [[ "$(sha256sum "$worker" | cut -d' ' -f1)" == "$LEGACY_13_14_WORKER_SHA256" ]]; then
      legacy_bootstrap=1
      return 0
    fi
    echo "legacy/non-lease-aware installed hook worker is not the approved 13.14.0 artifact" >&2
    return 1
  fi
}
wait_for_legacy_artifact_drain() {
  local worker="$1" pid cmdline found
  [[ "$legacy_bootstrap" == 1 ]] || return 0
  for _ in {1..60}; do
    found=0
    for cmdline in /proc/[0-9]*/cmdline; do
      [[ -r "$cmdline" ]] || continue
      pid="${cmdline#/proc/}"; pid="${pid%/cmdline}"
      [[ "$pid" == "$$" ]] && continue
      tr '\0' ' ' < "$cmdline" 2>/dev/null | grep -Fq -- "$worker" && { found=1; break; }
    done
    [[ "$found" == 0 ]] && return 0
    sleep 0.25
  done
  echo "approved legacy 13.14.0 hook processes did not drain" >&2
  return 1
}
validate_sqlite_snapshot() {
  local snapshot="$1"
  bun -e 'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1],{readonly:true}); try { const integrity=db.query("PRAGMA integrity_check").values(); const foreignKeys=db.query("PRAGMA foreign_key_check").values(); if(integrity.length!==1 || integrity[0][0]!=="ok" || foreignKeys.length!==0) process.exit(1); } finally { db.close(); }' "$snapshot"
}

assert_no_open_sqlite_handles() {
  local files=()
  [[ -e "$data_dir/claude-mem.db" ]] && files+=("$data_dir/claude-mem.db")
  [[ -e "$data_dir/claude-mem.db-wal" ]] && files+=("$data_dir/claude-mem.db-wal")
  [[ -e "$data_dir/claude-mem.db-shm" ]] && files+=("$data_dir/claude-mem.db-shm")
  ((${#files[@]} == 0)) && return 0
  if fuser -s "${files[@]}" 2>/dev/null; then
    echo "SQLite files are still open after worker quiescence" >&2
    return 1
  fi
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
  for item in "${metadata_files[@]}" "$data_dir/settings.json" "$data_dir/build-attestation-v1.json" "$data_dir/chroma"; do
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
  read -r window_phase window_generation window_detached_at < <(node - "$data_dir/release-window-v1.json" <<'NODE'
const fs=require('fs'); const w=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if (!w || w.schemaVersion !== 1 || !Number.isSafeInteger(w.generation) || w.generation < 1 || typeof w.phase !== 'string') process.exit(1);
// Older release-window writers did not name the detach field, but for a
// hooks_detached window its durable updatedAt is unambiguously that transition.
const detachedAt=w.hooksDetachedAt || ((w.phase==='hooks_detached'||w.phase==='hooks_drained') ? w.updatedAt : '');
console.log(w.phase, w.generation, detachedAt);
NODE
) || { echo "release window is unreadable; preserving maintenance fence" >&2; return 1; }
  [[ "$window_phase" != recovery_reconciled && "$window_phase" != failed ]] || return 0
  if [[ ! -e "$data_dir/release-transaction-v1.json" ]]; then
    local window_started_at window_old_hash
    read -r window_started_at window_old_hash < <(node - "$data_dir/release-window-v1.json" <<'NODE'
const fs=require('fs'); const w=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if (typeof w.startedAt !== 'string' || typeof w.oldArtifactSha256 !== 'string') process.exit(1);
console.log(w.startedAt, w.oldArtifactSha256);
NODE
) || return 1
    reconcile_no_receipt_window "$window_phase" "$window_generation" "$window_started_at" "$window_old_hash" "$window_detached_at"
    return $?
  fi
  # Crash after the durable no-op receipt but before the window transition is
  # harmless: replay the exact terminal transition without inspecting it as a
  # normal restore receipt.
  if node - "$data_dir/release-transaction-v1.json" "$window_generation" <<'NODE'
const fs=require('fs'); const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
process.exit(r && r.schemaVersion===1 && r.operation==='abort' && r.phase==='aborted' && r.generation===Number(process.argv[3]) ? 0 : 1);
NODE
  then
    node "$repo_dir/scripts/release-window.cjs" reconcile_noop "$data_dir" "pre-snapshot no-op reconciliation generation $window_generation" >/dev/null || return 1
    echo '{"operation":"abort","result":"recovery_reconciled"}'
    return 0
  fi
  # A complete receipt from an earlier generation is terminal historical
  # evidence, not the transaction for this active pre-snapshot window.  It is
  # accepted only after strict shape validation; nonterminal, newer, malformed
  # or same-generation receipts continue through the normal fenced path.
  if [[ "$window_phase" == prepared || "$window_phase" == hooks_detached || "$window_phase" == hooks_drained ]]; then
    read -r receipt_generation receipt_phase < <(node - "$data_dir/release-transaction-v1.json" <<'NODE'
const fs=require('fs');
try {
  const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  if (!r || r.schemaVersion!==1 || typeof r.id!=='string' || !Number.isSafeInteger(r.generation) || r.generation<1
    || typeof r.phase!=='string' || !['worker_quiesced','snapshot_ready','artifact_installed','worker_attested','hooks_attached','complete'].includes(r.phase)
    || typeof r.backupDir!=='string' || typeof r.oldWorkerPath!=='string' || typeof r.oldVersion!=='string'
    || !Number.isSafeInteger(r.quiescedWorkerPid) || r.quiescedWorkerPid<2 || !Array.isArray(r.targets)) process.exit(1);
  console.log(r.generation, r.phase);
} catch { process.exit(1); }
NODE
    ) || { echo "release transaction receipt is malformed; preserving maintenance fence" >&2; return 1; }
    if [[ "$receipt_generation" -lt "$window_generation" ]]; then
      [[ "$receipt_phase" == complete ]] || { echo "older nonterminal receipt cannot reconcile active release window" >&2; return 1; }
      read -r window_started_at window_old_hash < <(node - "$data_dir/release-window-v1.json" <<'NODE'
const fs=require('fs'); const w=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if (typeof w.startedAt!=='string' || typeof w.oldArtifactSha256!=='string') process.exit(1);
console.log(w.startedAt, w.oldArtifactSha256);
NODE
      ) || return 1
      reconcile_no_receipt_window "$window_phase" "$window_generation" "$window_started_at" "$window_old_hash" "$window_detached_at" 1
      return $?
    fi
    [[ "$receipt_generation" == "$window_generation" ]] || { echo "newer receipt cannot reconcile active release window" >&2; return 1; }
  fi
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
const compatible = windowPhase === 'rolling_back'
  ? Number.isInteger(receiptRank) && receiptRank >= rank.snapshot_ready
  : Number.isInteger(rank[windowPhase]) && Number.isInteger(receiptRank) && rank[windowPhase] <= receiptRank;
process.exit(compatible ? 0 : 1);
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
    assert_no_open_sqlite_handles || { echo "SQLite handles remained after quiescence; preserving maintenance fence" >&2; return 1; }
    [[ -f "$data_dir/settings.json" ]] && cp -a "$data_dir/settings.json" "$backup_dir/"; [[ -f "$data_dir/build-attestation-v1.json" ]] && cp -a "$data_dir/build-attestation-v1.json" "$backup_dir/"
    if [[ -f "$data_dir/claude-mem.db" ]]; then printf present > "$backup_dir/database-snapshot-state"; AUDIT_DB="$backup_dir/claude-mem.db" bun -e 'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1],{readonly:true}); db.run(`VACUUM INTO ${JSON.stringify(process.env.AUDIT_DB)}`); db.close()' "$data_dir/claude-mem.db" || return 1; else printf absent > "$backup_dir/database-snapshot-state"; fi
    [[ -d "$data_dir/chroma" ]] && cp -a "$data_dir/chroma" "$backup_dir/"
    while IFS= read -r target; do [[ -n "$target" && "$target" == "$home_dir/"* ]] || return 1; assert_target_root "$target" || return 1; validate_backup_source_tree "$target" || return 1; reconcile_presence "$target"; key="$(printf %s "$target" | sha256sum | cut -d' ' -f1)"; [[ -d "$target" ]] && cp -aL -- "$target" "$backup_dir/targets/$key"; done < <(node -e 'for(const t of JSON.parse(process.argv[1])) console.log(t)' "$receipt_targets_json")
    for item in "${metadata_files[@]}"; do reconcile_presence "$item"; key="$(printf %s "$item" | sha256sum | cut -d' ' -f1)"; [[ -f "$item" ]] && cp -a "$item" "$backup_dir/metadata/$key"; done
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
    while IFS= read -r target; do
      key="$(printf %s "$target" | sha256sum | cut -d' ' -f1)"; state="$(cat "$backup_dir/presence/$key")" || return 1
      begin_restore_target "$target" || return 1
      check_restore_target "$target" || return 1
      rm -rf -- "$target" || return 1
      check_restore_target "$target" || return 1
      if [[ "$state" != absent ]]; then
        mkdir -p "$(dirname "$target")" || return 1
        check_restore_target "$target" || return 1
        cp -a "$backup_dir/targets/$key" "$target" || return 1
        check_restore_target "$target" || return 1
      fi
    done < <(node -e 'for(const t of JSON.parse(process.argv[1])) console.log(t)' "$receipt_targets_json")
  fi
  for item in "${metadata_files[@]}" "$data_dir/settings.json" "$data_dir/build-attestation-v1.json"; do
    key="$(printf %s "$item" | sha256sum | cut -d' ' -f1)"; state="$(cat "$backup_dir/presence/$key")" || return 1
    if [[ "$state" == absent && ! -e "$item" && ! -L "$item" ]]; then assert_target_root "$item" || return 1; continue; fi
    begin_restore_target "$item" || return 1; check_restore_target "$item" || return 1
    if [[ "$state" == present ]]; then
      mkdir -p "$(dirname "$item")" || return 1; check_restore_target "$item" || return 1
      [[ "$item" == "$data_dir/"* ]] && cp -a "$backup_dir/$(basename "$item")" "$item" || cp -a "$backup_dir/metadata/$key" "$item" || return 1
      check_restore_target "$item" || return 1
    else
      rm -f -- "$item" || return 1; check_restore_target "$item" || return 1
    fi
  done
  state="$(cat "$backup_dir/database-snapshot-state")" || return 1
  begin_restore_target "$data_dir/claude-mem.db" || return 1; check_restore_target "$data_dir/claude-mem.db" || return 1
  rm -f -- "$data_dir/claude-mem.db-wal" "$data_dir/claude-mem.db-shm" || return 1; check_restore_target "$data_dir/claude-mem.db" || return 1
  if [[ "$state" == present ]]; then
    [[ -f "$backup_dir/claude-mem.db" ]] || return 1; cp -a "$backup_dir/claude-mem.db" "$data_dir/claude-mem.db" || return 1; check_restore_target "$data_dir/claude-mem.db" || return 1
  elif [[ "$state" == absent ]]; then
    rm -f -- "$data_dir/claude-mem.db" || return 1; check_restore_target "$data_dir/claude-mem.db" || return 1
  else return 1; fi
  key="$(printf %s "$data_dir/chroma" | sha256sum | cut -d' ' -f1)"; state="$(cat "$backup_dir/presence/$key")" || return 1
  begin_restore_target "$data_dir/chroma" || return 1; check_restore_target "$data_dir/chroma" || return 1
  rm -rf -- "$data_dir/chroma" || return 1; check_restore_target "$data_dir/chroma" || return 1
  [[ "$state" == absent ]] || { cp -a "$backup_dir/chroma" "$data_dir/chroma" || return 1; check_restore_target "$data_dir/chroma" || return 1; }
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
if [[ "${CLAUDE_MEM_UPGRADE_SKIP_CHECKS:-0}" != 1 ]]; then bun run typecheck; bun test --max-concurrency=1 tests; git diff --check; fi
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
  local running_health running_pid running_token running_pgid lease_json lease_pid lease_token group_live
  running_health="$(curl -fsS --max-time 2 "$health_url")" || { echo "running worker health unavailable; refusing state restore" >&2; return 1; }
  running_pid="$(printf '%s' "$running_health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).pid;if(!Number.isSafeInteger(p)||p<2)process.exit(1);console.log(p)}catch{process.exit(1)}})')" || { echo "running worker PID unavailable; refusing state restore" >&2; return 1; }
  running_token="$(awk '{print $22}' "/proc/$running_pid/stat" 2>/dev/null)" || { echo "running worker identity unavailable; refusing state restore" >&2; return 1; }
  running_pgid="$(ps -o pgid= -p "$running_pid" | tr -d ' ')" || return 1
  [[ "$running_pgid" == "$running_pid" ]] || { echo "managed worker does not own a dedicated process group" >&2; return 1; }
  # A previous, dead Chroma owner can leave a lock that predates this release.
  # Reap it only under the drained hook fence, with exact owner and inode proof.
  node "$repo_dir/scripts/reap-stale-writer-lease.cjs" "$data_dir" "$running_pid" || return 1
  curl -fsS --max-time 2 -X POST "$shutdown_url" >/dev/null 2>&1 || npx claude-mem stop >/dev/null 2>&1 || true
  # The HTTP listener closes before final teardown (including chroma-mcp and
  # its writer lock). Replacing the plugin as soon as the port is free races
  # that teardown, so require the original worker process to be gone as well.
  for _ in {1..60}; do
    if ! curl -fsS --max-time 1 "$health_url" >/dev/null 2>&1 && ! kill -0 "$running_pid" 2>/dev/null; then
      verify_writer_lease_released && { stopped_worker_pid="$running_pid"; return 0; }
      # The daemon is a session/process-group leader. If it exits before its
      # Chroma transport finishes teardown, descendants are reparented and can
      # no longer be discovered from the dead PID. Drain only the captured,
      # identity-bound group; never touch an unrelated legacy MCP group.
      lease_json="$(node -e 'const fs=require("fs"),j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!j||j.pid!==Number(process.argv[2])||j.startToken!==process.argv[3]||j.dataDir!==process.argv[4])process.exit(1);process.stdout.write(JSON.stringify(j))' "$data_dir/chroma/.claude-mem-chroma-writer.lock" "$running_pid" "$running_token" "$data_dir/chroma")" || { echo "worker process exited but writer lease identity is untrusted" >&2; return 1; }
      kill -TERM -- "-$running_pgid" 2>/dev/null || true
      for _ in {1..20}; do group_live="$(ps -g "$running_pgid" -o pid= 2>/dev/null | tr -d '[:space:]' || true)"; [[ -z "$group_live" ]] && break; sleep 0.25; done
      group_live="$(ps -g "$running_pgid" -o pid= 2>/dev/null | tr -d '[:space:]' || true)"
      if [[ -n "$group_live" ]]; then kill -KILL -- "-$running_pgid" 2>/dev/null || return 1; fi
      for _ in {1..20}; do group_live="$(ps -g "$running_pgid" -o pid= 2>/dev/null | tr -d '[:space:]' || true)"; [[ -z "$group_live" ]] && break; sleep 0.25; done
      [[ -z "$(ps -g "$running_pgid" -o pid= 2>/dev/null | tr -d '[:space:]' || true)" ]] || { echo "worker-owned process group did not drain" >&2; return 1; }
      [[ ! -e "/proc/$running_pid" ]] || { echo "worker PID reappeared during process-group drain" >&2; return 1; }
      verify_writer_lease_released && { stopped_worker_pid="$running_pid"; return 0; }
      node -e 'const fs=require("fs"),p=process.argv[1],pid=Number(process.argv[2]),token=process.argv[3],dir=process.argv[4];const s=fs.lstatSync(p),j=JSON.parse(fs.readFileSync(p,"utf8"));if(!s.isFile()||s.isSymbolicLink()||(process.getuid&&s.uid!==process.getuid())||(s.mode&0o002)!==0||((s.mode&0o020)!==0&&s.gid!==0)||j.pid!==pid||j.startToken!==token||j.dataDir!==dir)process.exit(1);fs.unlinkSync(p)' "$data_dir/chroma/.claude-mem-chroma-writer.lock" "$running_pid" "$running_token" "$data_dir/chroma" || { echo "stale writer lease changed during verified drain" >&2; return 1; }
      verify_writer_lease_released && { stopped_worker_pid="$running_pid"; return 0; }
      echo "worker-owned Chroma tree drained but writer lease remains" >&2; return 1
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
      begin_restore_target "$data_dir/claude-mem.db" || return 1
      check_restore_target "$data_dir/claude-mem.db" || return 1
      rm -f -- "$data_dir/claude-mem.db-wal" "$data_dir/claude-mem.db-shm" || return 1
      check_restore_target "$data_dir/claude-mem.db" || return 1
      mv -f -- "$rollback_db_stage" "$data_dir/claude-mem.db" || return 1
      check_restore_target "$data_dir/claude-mem.db" || return 1
      ;;
    absent)
      # The pre-install state had no store; restore that absence, including
      # any sidecars a partially started replacement may have created.
      begin_restore_target "$data_dir/claude-mem.db" || return 1
      check_restore_target "$data_dir/claude-mem.db" || return 1
      rm -f -- "$data_dir/claude-mem.db" "$data_dir/claude-mem.db-wal" "$data_dir/claude-mem.db-shm" || return 1
      check_restore_target "$data_dir/claude-mem.db" || return 1
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
      begin_restore_target "$target" || return 1
      check_restore_target "$target" || return 1
      rm -rf -- "$target" || return 1
      check_restore_target "$target" || return 1
      if was_present "$target"; then [[ -d "$backup_dir/targets/$key" ]] || return 1; mkdir -p "$(dirname "$target")" || return 1; check_restore_target "$target" || return 1; cp -a "$backup_dir/targets/$key" "$target" || return 1; check_restore_target "$target" || return 1; fi
    done
  fi
  for metadata in "${metadata_files[@]}"; do
    key="$(printf %s "$metadata" | sha256sum | cut -d' ' -f1)"
    if ! was_present "$metadata" && [[ ! -e "$metadata" && ! -L "$metadata" ]]; then assert_target_root "$metadata" || return 1; continue; fi
    begin_restore_target "$metadata" || return 1; check_restore_target "$metadata" || return 1
    if was_present "$metadata"; then [[ -f "$backup_dir/metadata/$key" ]] || return 1; mkdir -p "$(dirname "$metadata")" || return 1; check_restore_target "$metadata" || return 1; cp -a "$backup_dir/metadata/$key" "$metadata" || return 1; check_restore_target "$metadata" || return 1; else rm -f -- "$metadata" || return 1; check_restore_target "$metadata" || return 1; fi
  done
  begin_restore_target "$data_dir/settings.json" || return 1; check_restore_target "$data_dir/settings.json" || return 1
  if was_present "$data_dir/settings.json"; then cp -a "$backup_dir/settings.json" "$data_dir/settings.json" || return 1; check_restore_target "$data_dir/settings.json" || return 1; else rm -f -- "$data_dir/settings.json" || return 1; check_restore_target "$data_dir/settings.json" || return 1; fi
  if [[ "${snapshot_complete:-0}" == 1 ]]; then
    restore_database || { echo "ROLLBACK ABORTED: staged SQLite snapshot failed validation or restore" >&2; return 1; }
  fi
  if [[ -f "$backup_dir/build-attestation-v1.json" ]]; then
    begin_restore_target "$data_dir/build-attestation-v1.json" || return 1; check_restore_target "$data_dir/build-attestation-v1.json" || return 1
    cp -a "$backup_dir/build-attestation-v1.json" "$data_dir/build-attestation-v1.json" || return 1; check_restore_target "$data_dir/build-attestation-v1.json" || return 1
  else
    begin_restore_target "$data_dir/build-attestation-v1.json" || return 1; check_restore_target "$data_dir/build-attestation-v1.json" || return 1
    rm -f -- "$data_dir/build-attestation-v1.json" || return 1; check_restore_target "$data_dir/build-attestation-v1.json" || return 1
  fi
  begin_restore_target "$data_dir/chroma" || return 1; check_restore_target "$data_dir/chroma" || return 1
  rm -rf -- "$data_dir/chroma" || return 1; check_restore_target "$data_dir/chroma" || return 1
  if was_present "$data_dir/chroma"; then [[ -d "$backup_dir/chroma" ]] || return 1; cp -a "$backup_dir/chroma" "$data_dir/chroma" || return 1; check_restore_target "$data_dir/chroma" || return 1; fi
  rollback_start_auth="$(managed_start_token)" || return 1
  replacement_started=1
  if ! start_and_verify_version "$(cat "$backup_dir/old-version")" "$(cat "$backup_dir/old-worker-path")" "$rollback_start_auth"; then
    echo "old worker failed health verification" >&2
    return 1
  else
    rollback_receipt="rollback restored durable state"
  fi
  node "$repo_dir/scripts/release-window.cjs" fail "$data_dir" "$rollback_receipt" >/dev/null 2>&1 || true
  node "$repo_dir/scripts/release-transaction.cjs" complete "$data_dir" >/dev/null 2>&1 || true
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
wait_for_legacy_artifact_drain "$old_worker_path"
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
# WAL/SHM files may persist after the last SQLite connection closes. Prove no
# process still owns them; VACUUM INTO then folds committed WAL state into one
# complete replacement snapshot. Rollback never restores the old sidecars.
assert_no_open_sqlite_handles
[[ -f "$data_dir/settings.json" ]] && cp -a "$data_dir/settings.json" "$backup_dir/"
[[ -f "$data_dir/build-attestation-v1.json" ]] && cp -a "$data_dir/build-attestation-v1.json" "$backup_dir/"
if [[ -f "$data_dir/claude-mem.db" ]]; then
  printf '%s\n' present > "$backup_dir/database-snapshot-state"
  AUDIT_DB="$backup_dir/claude-mem.db" bun -e 'import {Database} from "bun:sqlite"; const db=new Database(process.argv[1],{readonly:true}); db.run(`VACUUM INTO ${JSON.stringify(process.env.AUDIT_DB)}`); db.close()' "$data_dir/claude-mem.db"
else
  printf '%s\n' absent > "$backup_dir/database-snapshot-state"
fi
[[ -d "$data_dir/chroma" ]] && cp -a "$data_dir/chroma" "$backup_dir/"
# Backups are restore payloads, not development worktrees.  Dereference the
# source tree so inherited links (for example openclaw/skills/do/SKILL.md ->
# ../../../plugin/skills/do/SKILL.md) cannot survive into the backup and be
# mistaken for an unsafe restore path. cp fails closed for dangling links,
# while the subsequent whole-tree validator still rejects any link introduced
# by a damaged or tampered backup.
for target in "${targets[@]}"; do key="$(presence_key "$target")"; record_presence "$target"; validate_backup_source_tree "$target"; [[ -d "$target" ]] && cp -aL -- "$target" "$backup_dir/targets/$key"; done
for metadata in "${metadata_files[@]}"; do key="$(presence_key "$metadata")"; record_presence "$metadata"; [[ -f "$metadata" ]] && cp -a "$metadata" "$backup_dir/metadata/$key"; done
validate_backup_snapshot || { echo "backup staging validation failed; refusing replacement" >&2; false; }
node "$repo_dir/scripts/release-transaction.cjs" phase "$data_dir" snapshot_ready >/dev/null
node "$repo_dir/scripts/release-window.cjs" snapshot_ready "$data_dir" >/dev/null
snapshot_complete=1

for target in "${targets[@]}"; do
  # The externally approved manifest is a capability: recheck its exact bytes
  # immediately before every source use, staging operation, and installation.
  [[ -z "${CLAUDE_MEM_APPROVED_MANIFEST_SHA256:-}" || "$(sha256sum "$manifest" | cut -d' ' -f1)" == "$CLAUDE_MEM_APPROVED_MANIFEST_SHA256" ]] || { echo "external manifest digest changed before staging" >&2; false; }
  assert_target_root "$target"
  mkdir -p "$(dirname "$target")"
  resolve_secure_target_parent "$target"
  target_parent="$TARGET_PARENT"; target_parent_id="$TARGET_PARENT_ID"
  run_target_hook before-stage "$target"
  revalidate_secure_target_parent "$target" "$target_parent" "$target_parent_id"
  stage="$(mktemp -d "$target_parent/.claude-mem-stage.XXXXXX")"
  if [[ "$target" == "$home_dir/.claude/plugins/marketplaces/thedotmack" ]]; then
    # Copy dependency contents, never a worktree-local symlink.  A symlink is
    # valid while developing but breaks after the staged marketplace is moved
    # under ~/.claude and causes doctor to report a missing runtime.
    dependency_manifest="$backup_dir/dependency-tree-$(presence_key "$target").json"
    # Build a private, fully dereferenced dependency tree before the generic
    # worktree copy.  node_modules commonly contains internal .bin links;
    # validating the source tree after copying would reject those links before
    # rsync has a chance to dereference them.
    # Historical contract marker: dependency-tree-manifest.cjs" create "$repo_dir/node_modules"
    node "$repo_dir/scripts/dependency-tree-manifest.cjs" stage "$repo_dir/node_modules" "$dependency_manifest" "$stage/node_modules"
    approved_dependencies="$(json_field dependencyManifest)"
    [[ "$approved_dependencies" == maintained-patches/dependencies-v"$expected_version".json ]] || { echo "approved dependency closure missing" >&2; false; }
    node "$repo_dir/scripts/dependency-tree-manifest.cjs" verify "$stage/node_modules" "$repo_dir/$approved_dependencies"
    [[ -z "${CLAUDE_MEM_APPROVED_MANIFEST_SHA256:-}" || "$(sha256sum "$manifest" | cut -d' ' -f1)" == "$CLAUDE_MEM_APPROVED_MANIFEST_SHA256" ]] || { echo "external manifest digest changed before dependency copy" >&2; false; }
    rsync -a --delete --exclude='.git' --exclude='node_modules' "$repo_dir/" "$stage/"
    node "$repo_dir/scripts/dependency-tree-manifest.cjs" verify "$stage/node_modules" "$dependency_manifest"
    [[ -d "$target/.git" ]] && cp -a "$target/.git" "$stage/.git"
    staged_bundle="$stage/plugin/scripts/worker-service.cjs"
  else
    rsync -a --delete "$repo_dir/plugin/" "$stage/"
    staged_bundle="$stage/scripts/worker-service.cjs"
  fi
  runtime_root="$(dirname "$staged_bundle")/.."
  [[ -f "$runtime_root/package.json" && -f "$runtime_root/ui/viewer.html" && -f "$runtime_root/skills/how-it-works/onboarding-explainer.md" ]] || { echo "staged runtime assets missing: $runtime_root" >&2; false; }
  node "$repo_dir/scripts/verify-approved-manifest.cjs" --manifest "$manifest" --bundle "$repo_dir/plugin/scripts/worker-service.cjs" --repo "$repo_dir" --mode "$approval_scope" --payload-root "$runtime_root" >/dev/null
  [[ "$(sha256sum "$staged_bundle" | cut -d' ' -f1)" == "$expected_bundle" ]] || { echo "staged bundle hash mismatch" >&2; false; }
  [[ -z "${CLAUDE_MEM_APPROVED_MANIFEST_SHA256:-}" || "$(sha256sum "$manifest" | cut -d' ' -f1)" == "$CLAUDE_MEM_APPROVED_MANIFEST_SHA256" ]] || { echo "external manifest digest changed before install" >&2; false; }
  install_started=1
  run_target_hook before-finalize "$target"
  revalidate_secure_target_parent "$target" "$target_parent" "$target_parent_id"
  [[ ! -L "$target" ]] || { echo "refusing symlink target before removal: $target" >&2; false; }
  rm -rf -- "$target"
  revalidate_secure_target_parent "$target" "$target_parent" "$target_parent_id"
  [[ -d "$stage" && ! -L "$stage" ]] || { echo "staged directory is not safe: $stage" >&2; false; }
  mv -- "$stage" "$target"
  revalidate_secure_target_parent "$target" "$target_parent" "$target_parent_id"
  [[ -d "$target" && ! -L "$target" ]] || { echo "final target is not a directory: $target" >&2; false; }
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
# Exec-form Claude hooks require this binary before hook attachment. Compile only
# the reviewed bundle; preserve Bun's upstream cwd-autoload isolation.
launcher_path="$home_dir/.local/bin/claude-mem"
launcher_parent="$(dirname "$launcher_path")"
mkdir -p "$launcher_parent"
resolve_secure_target_parent "$launcher_path"
launcher_parent_id="$TARGET_PARENT_ID"
if [[ -e "$launcher_path" ]] && ! "$launcher_path" --version 2>/dev/null | grep -Eq '^[0-9]+$'; then
  echo "refusing to replace a foreign claude-mem executable" >&2; false
fi
launcher_stage="$launcher_parent/.claude-mem-stage-$$"
assert_target_root "$launcher_stage"
[[ ! -e "$launcher_stage" && ! -L "$launcher_stage" ]] || { echo "launcher staging path exists" >&2; false; }
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  "$(dirname "$new_worker_path")/claude-mem-launcher.cjs" --outfile "$launcher_stage" >/dev/null
launcher_protocol="$(sed -n 's/^export const LAUNCHER_PROTOCOL = \([0-9]*\);$/\1/p' "$repo_dir/src/launcher/launcher-protocol.ts")"
[[ -n "$launcher_protocol" && "$("$launcher_stage" --version)" == "$launcher_protocol" ]] || { echo "launcher protocol mismatch" >&2; false; }
revalidate_secure_target_parent "$launcher_path" "$launcher_parent" "$launcher_parent_id"
mv -- "$launcher_stage" "$launcher_path"
new_start_auth="$(managed_start_token)"
replacement_started=1
start_and_verify_version "$expected_version" "$new_worker_path" "$new_start_auth"
curl -fsS --max-time 10 "${health_url%/api/health}/api/readiness" >/dev/null
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
node "$repo_dir/scripts/release-window.cjs" prepare_recovery "$data_dir" >/dev/null
node "$repo_dir/scripts/release-window.cjs" window_closed "$data_dir" >/dev/null
curl -fsS --max-time 120 -H 'Content-Type: application/json' \
  --data "{\"generation\":$release_generation}" \
  "${health_url%/api/health}/api/recovery/reconcile-release" >/dev/null
for _ in {1..120}; do
  [[ "$(node -e 'try{console.log(require(process.argv[1]).phase)}catch{}' "$data_dir/release-window-v1.json")" == recovery_reconciled ]] && break
  sleep 0.25
done
[[ "$(node -e 'console.log(require(process.argv[1]).phase)' "$data_dir/release-window-v1.json")" == recovery_reconciled ]] || { echo "replacement worker did not reconcile the release window" >&2; false; }
node "$repo_dir/scripts/release-transaction.cjs" complete "$data_dir" >/dev/null
trap - ERR INT TERM
echo "Installed and verified; backup: $backup_dir"
