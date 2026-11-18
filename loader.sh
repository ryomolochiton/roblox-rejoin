#!/bin/bash
# loader.sh - install, update, autostart & launch Roblox Rejoin (VIP / LITE)
# Run `loader --help` for usage.
#
# Speed: nothing is installed unless really missing (no blanket `pkg update`), one stamp records the
# last healthy env so a start with entry+node+modules intact goes straight to node, and the repo is
# refreshed at most once a day.
set -u

R="https://github.com/ryomolochiton/roblox-rejoin"
PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"
TERMUX_BIN="$PREFIX_DIR/bin"
export PATH="$TERMUX_BIN:$PATH:/system/bin:/system/xbin"

# Resolve real Termux home even if invoked oddly
TERMUX_PKG="${TERMUX_APP__PACKAGE_NAME:-}"
if [ -z "$TERMUX_PKG" ]; then
  case "$PREFIX_DIR" in
    /data/data/*/files/usr) TERMUX_PKG="$(echo "$PREFIX_DIR" | cut -d/ -f4)" ;;
    /data/user/*/*/files/usr) TERMUX_PKG="$(echo "$PREFIX_DIR" | cut -d/ -f5)" ;;
    *) TERMUX_PKG="com.termux" ;;
  esac
fi
export TERMUX_APP__PACKAGE_NAME="$TERMUX_PKG"

REAL_HOME="$HOME"
case "$REAL_HOME" in
  */files/home|*/files/home/) ;;
  *)
    if [ -d "/data/data/$TERMUX_PKG/files/home" ]; then
      REAL_HOME="/data/data/$TERMUX_PKG/files/home"
    fi
    ;;
esac

D="${REJOIN_REPO_DIR:-$REAL_HOME/roblox-rejoin}"
ENTRY_VIP="rejoin.cjs"
ENTRY_LITE="rejoin lite.cjs"
L="$TERMUX_BIN/loader"

# Persistent config & isolated NPM environment outside the git repo
ROBLOX_REJOIN_HOME="${ROBLOX_REJOIN_HOME:-$REAL_HOME/.roblox-rejoin}"
ENV_DIR="${ROBLOX_REJOIN_ENV:-$ROBLOX_REJOIN_HOME/env}"
TMP_DIR="${ROBLOX_REJOIN_TMP:-$ROBLOX_REJOIN_HOME/tmp}"
export ROBLOX_REJOIN_HOME ROBLOX_REJOIN_ENV="$ENV_DIR" ROBLOX_REJOIN_TMP="$TMP_DIR" ROBLOX_REJOIN_REPO="$D"
export NODE_PATH="$ENV_DIR/node_modules"

mkdir -p "$ROBLOX_REJOIN_HOME" "$ENV_DIR" "$TMP_DIR" 2>/dev/null
chmod 700 "$TMP_DIR" 2>/dev/null || true

CFGS="multi_configs.json webhook_config.json package_prefix_config.json activity_config.json autoexec_config.json ui_config.json run_options.json last_session.json"
LAST_FILE="$ROBLOX_REJOIN_HOME/loader_choice"

# Stamps (all optional: a missing stamp only means "do the slower check once")
ENV_STAMP_V3="$ENV_DIR/.env_ok_v3"
UPDATE_STAMP_FILE="$ROBLOX_REJOIN_HOME/.repo_checked"
UPDATE_MAX_AGE_S=86400   # refresh the repo at most once a day on a plain start

VIP_NPM_DEPS="axios cli-table3 figlet"
VIP_REQUIRED_MODULES="axios cli-table3"
LITE_REQUIRED_MODULES=""
OPT_SYS_PKGS="termux-api procps"
VIP_EXTRA_PKGS="nano"

AUTOSTART_BOOT_SCRIPT="$REAL_HOME/.termux/boot/roblox-rejoin.sh"
AUTOSTART_OFF_PATH="$ROBLOX_REJOIN_HOME/autostart_disabled"
AUTOSTART_ARMED_PATH="$ROBLOX_REJOIN_HOME/autostart_armed"
AUTOSTART_PENDING_PATH="$ROBLOX_REJOIN_HOME/autostart_pending"
BOOT_STATUS_PATH="$ROBLOX_REJOIN_HOME/boot_status.json"
BOOT_LOG_PATH="$ROBLOX_REJOIN_HOME/boot.log"
HEARTBEAT_PATH="$ROBLOX_REJOIN_HOME/heartbeat"
RC_BEGIN="# >>> roblox-rejoin autostart (managed by loader) >>>"
RC_END="# <<< roblox-rejoin autostart <<<"

IS_ROOT=0
[ "$(id -u 2>/dev/null || echo 1)" = "0" ] && IS_ROOT=1

# one "y" keeps apt non-interactive (a piped `yes` would write forever and block the install)
pkg_wrap() { printf 'y\n' | command pkg "$@"; }

sh_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

now_s() { date +%s; }

# Hand files back to the Termux user if loader was invoked as root
fix_owner() {
  [ "$IS_ROOT" = "1" ] || return 0
  local ref_uid ref_gid
  ref_uid="$(stat -c '%u' "$REAL_HOME" 2>/dev/null || echo "")"
  ref_gid="$(stat -c '%g' "$REAL_HOME" 2>/dev/null || echo "")"
  if [ -n "$ref_uid" ] && [ -n "$ref_gid" ]; then
    chown -R "$ref_uid:$ref_gid" "$@" 2>/dev/null || true
  fi
}

file_mtime() { stat -c '%Y' "$1" 2>/dev/null || echo 0; }

# Migrate legacy configs out of the git repo before any reset/clean
save_old_configs() {
  [ -d "$D" ] || return 0
  local f
  for f in $CFGS; do
    if [ -f "$D/$f" ] && [ ! -f "$ROBLOX_REJOIN_HOME/$f" ]; then
      cp -f "$D/$f" "$ROBLOX_REJOIN_HOME/$f" 2>/dev/null && mv -f "$D/$f" "$D/$f.migrated" 2>/dev/null || true
    fi
  done
  fix_owner "$ROBLOX_REJOIN_HOME"
  return 0
}

# Install / update `loader` binary in $TERMUX_BIN
install_self() {
  local self
  self="$(readlink -f "$0" 2>/dev/null || echo "$0")"
  if [ -f "$self" ] && [ "$self" != "$L" ] && { [ ! -f "$L" ] || ! cmp -s "$self" "$L"; }; then
    mkdir -p "$TERMUX_BIN" 2>/dev/null || true
    cp -f "$self" "$L" 2>/dev/null && sed -i 's/\r$//' "$L" 2>/dev/null && chmod 755 "$L" 2>/dev/null || true
    fix_owner "$L"
  fi
}

# ---------------------------------------------------------------------------------------
# Stamp helpers: the stamp is only "ok" while the entry script is still newer-older than it,
# so an update / reinstall invalidates it automatically.
# ---------------------------------------------------------------------------------------
node_bin_path() {
  local n="$TERMUX_BIN/node"
  [ -x "$n" ] && { echo "$n"; return 0; }
  command -v node 2>/dev/null || echo ""
}

stamp_valid() {
  local stamp="$1" entry="$2"
  [ -f "$stamp" ] || return 1
  [ -f "$entry" ] || return 1
  [ "$(file_mtime "$stamp")" -ge "$(file_mtime "$entry")" ] || return 1
  return 0
}

write_stamp() {
  local stamp="$1" mode="$2"
  {
    echo "mode=$mode"
    echo "node=$(node_bin_path)"
    printf 'entry=%s\n' "$3"
    echo "modules=$ENV_DIR/node_modules"
    echo "written=$(now_s)"
  } > "$stamp.tmp" 2>/dev/null && mv -f "$stamp.tmp" "$stamp" 2>/dev/null
  fix_owner "$stamp"
}

entry_for_mode() {
  case "$1" in
    2|lite) echo "$D/$ENTRY_LITE" ;;
    *) echo "$D/$ENTRY_VIP" ;;
  esac
}

# True when this start can go straight to node: everything the entry needs was verified after the
# last change of the entry file / node binary. Costs two stats + one read, no subprocess.
fast_ready() {
  local mode="$1" entry n
  entry="$(entry_for_mode "$mode")"
  [ -f "$entry" ] || return 1
  stamp_valid "$ENV_STAMP_V3" "$entry" || return 1
  n="$(node_bin_path)"
  [ -n "$n" ] || return 1
  # the stamp stores the exact node + mode verified: any change forces the slow path once
  # (shell builtins, because grep would fork a process on every start)
  local line want_node="node=$n" want_mode="mode=$mode" _st_node=0 _st_mode=0
  while IFS= read -r line; do
    case "$line" in
      "$want_node") _st_node=1 ;;
      "$want_mode"|"mode=repair") _st_mode=1 ;;
    esac
  done < "$ENV_STAMP_V3" 2>/dev/null
  [ "$_st_node" = "1" ] && [ "$_st_mode" = "1" ] || return 1
  # sqlite3 is the only thing the tool cannot start without; one -x test instead of a `command -v` fork
  [ -x "$TERMUX_BIN/sqlite3" ] || command -v sqlite3 >/dev/null 2>&1 || return 1
  return 0
}

# ---------------------------------------------------------------------------------------
# Repo update
# ---------------------------------------------------------------------------------------
download_tarball() {
  local tmp_dl url
  tmp_dl="$(mktemp -d 2>/dev/null || echo "$TMP_DIR/dl_$$")"
  mkdir -p "$tmp_dl"
  url="$R/archive/refs/heads/main.tar.gz"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --connect-timeout 8 --retry 1 -o "$tmp_dl/r.tgz" "$url" || { rm -rf "$tmp_dl"; return 1; }
  elif command -v wget >/dev/null 2>&1; then
    wget -T 12 -O "$tmp_dl/r.tgz" "$url" || { rm -rf "$tmp_dl"; return 1; }
  else
    rm -rf "$tmp_dl"
    return 1
  fi
  mkdir -p "$D"
  find "$D" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} + 2>/dev/null || true
  tar -xzf "$tmp_dl/r.tgz" -C "$D" --strip-components=1 || { rm -rf "$tmp_dl"; return 1; }
  rm -rf "$tmp_dl"
  fix_owner "$D"
  return 0
}

# should_update <force>
#   0 = update now, 1 = skip
should_update() {
  local force="${1:-0}"
  [ "$force" = "1" ] && return 0
  [ -d "$D/.git" ] || return 0               # first install / tarball installs keep working offline
  [ -f "$UPDATE_STAMP_FILE" ] || return 0
  local last age
  last="$(cat "$UPDATE_STAMP_FILE" 2>/dev/null | tr -dc '0-9')"
  [ -n "$last" ] || return 0
  age=$(( $(now_s) - last ))
  [ "$age" -ge "$UPDATE_MAX_AGE_S" ] && return 0
  return 1
}

mark_update_checked() {
  now_s > "$UPDATE_STAMP_FILE" 2>/dev/null || true
}

sync_repo() {
  local force="${1:-0}"
  save_old_configs

  if [ -d "$D" ] && { [ "$AUTOSTART" = "1" ] || [ "$NO_UPDATE" = "1" ]; } \
     && { [ -f "$D/$ENTRY_VIP" ] || [ -f "$D/$ENTRY_LITE" ]; }; then
    [ "$AUTOSTART" = "1" ] && echo "[*] Autostart mode — using existing local files." \
                          || echo "[*] Skipping repo update (--no-update)."
    return 0
  fi
  if ! should_update "$force"; then
    echo "[*] Using local files (repo last checked $(( ($(now_s) - $(cat "$UPDATE_STAMP_FILE" 2>/dev/null | tr -dc '0-9' || echo 0)) / 3600 ))h ago, max ${UPDATE_MAX_AGE_S}s)."
    return 0
  fi

  local use_tar=0 rc=0
  if [ ! -d "$D/.git" ]; then
    if [ -f "$D/$ENTRY_VIP" ] || [ -f "$D/$ENTRY_LITE" ]; then
      # installed without git (tarball / copied by hand): never re-download on start
      echo "[*] Existing local install in $D, not re-downloading."
      mark_update_checked
      return 0
    fi
    use_tar=1
  fi

  if [ "$use_tar" = "1" ]; then
    echo "[*] Downloading repository..."
    if download_tarball; then mark_update_checked; else
      echo "[-] Could not download repository. Check your internet connection."
      return 1
    fi
  else
    # a git checkout is guaranteed here: use_tar=1 covers every non-git case above
    (
      cd "$D" || exit 1
      cur="$(git remote get-url origin 2>/dev/null || echo "")"
      [ -n "$cur" ] && [ "$cur" != "$R" ] && git remote set-url origin "$R" 2>/dev/null || true
      if git fetch --depth 1 origin main >/dev/null 2>&1 || git fetch --all --prune >/dev/null 2>&1; then
        excl="-e node_modules"
        for f in $CFGS; do excl="$excl -e $f"; done
        git reset --hard origin/main >/dev/null 2>&1 || git reset --hard FETCH_HEAD >/dev/null 2>&1 || true
        # shellcheck disable=SC2086
        git clean -fd $excl >/dev/null 2>&1 || true
        exit 0
      fi
      # offline: keep the local copy instead of failing the launch
      exit 2
    ) || rc=$?
    if [ "$rc" = "2" ]; then
      echo "[!] Network/GitHub unreachable — continuing with local version."
    fi
    mark_update_checked
  fi
  fix_owner "$D"
  return 0
}

# ---------------------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------------------
use_official_mirror() {
  echo "[*] Switching Termux mirror to packages.termux.dev..."
  rm -f "$PREFIX_DIR/etc/termux/chosen_mirrors" 2>/dev/null || true
  mkdir -p "$PREFIX_DIR/etc/apt" 2>/dev/null || true
  echo "deb https://packages.termux.dev/apt/termux-main stable main" > "$PREFIX_DIR/etc/apt/sources.list"
  rm -rf "$PREFIX_DIR/var/lib/apt/lists/"* 2>/dev/null || true
}

heal_dpkg() {
  dpkg --configure -a >/dev/null 2>&1 || true
}

# install only what is listed and really missing; no blanket `pkg update`
pkg_install() {
  if [ "$IS_ROOT" = "1" ]; then
    echo "[!] Running as root: Termux pkg/apt cannot run under UID 0."
    echo "    Exit 'su' and run 'loader --repair' as the normal Termux user to install: $*"
    return 1
  fi
  heal_dpkg
  # `pkg install` refreshes the index by itself when it is stale, no need for a separate update
  DEBIAN_FRONTEND=noninteractive pkg_wrap install -y "$@" && return 0
  echo "[!] Retrying install ($*) with apt-get --fix-missing..."
  heal_dpkg
  # only now is a fresh index worth the wait (first try failed, most likely a stale list)
  DEBIAN_FRONTEND=noninteractive apt-get update -o Acquire::Retries=2 >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y --fix-missing "$@" && return 0
  use_official_mirror
  DEBIAN_FRONTEND=noninteractive apt-get install -y --fix-missing "$@" && return 0
  return 1
}

# install the subset of "$@" that is not on PATH yet.
# termux-wake-lock is the binary from the termux-api package but NOT the package name, so the
# binary -> package mapping is explicit here (otherwise it asked apt for a package called "termux-wake-lock").
pkg_name_for() {
  case "$1" in
    sqlite3) echo sqlite ;;
    termux-wake-lock) echo termux-api ;;
    *) echo "$1" ;;
  esac
}

pkg_ensure() {
  local missing="" p
  for p in "$@"; do
    command -v "$p" >/dev/null 2>&1 || missing="$missing $(pkg_name_for "$p")"
  done
  [ -z "$missing" ] && return 0
  echo "[*] Installing missing system package(s):$missing"
  # shellcheck disable=SC2086
  pkg_install $missing || return 1
  # `pkg install` can report success while a package was only partially configured;
  # verify the binaries are really on PATH now instead of trusting the exit code
  local still=""
  for p in "$@"; do
    command -v "$p" >/dev/null 2>&1 || still="$still $p"
  done
  [ -z "$still" ] && return 0
  echo "[-] Still missing after install:$still"
  return 1
}

node_modules_ok() {
  local n="$1" m
  [ -d "$ENV_DIR/node_modules" ] || return 1
  for m in $2; do
    NODE_PATH="$ENV_DIR/node_modules" "$n" -e "require.resolve('$m')" >/dev/null 2>&1 || return 1
  done
  return 0
}

# --repair / menu option 3: install everything, no shortcuts
setup_environment() {
  local mode="${1:-1}"
  local force="${2:-0}"
  local want_vip=0
  case "$mode" in 1|vip|repair|all) want_vip=1 ;; esac

  echo "[*] Checking Termux runtime environment..."

  command -v curl >/dev/null 2>&1 || pkg_ensure curl
  command -v tar >/dev/null 2>&1 || pkg_ensure tar
  command -v git >/dev/null 2>&1 || pkg_ensure git

  local n
  n="$(node_bin_path)"
  if [ -z "$n" ]; then
    pkg_ensure nodejs || { echo "[-] Could not install nodejs."; return 1; }
    n="$(node_bin_path)"
  fi
  if ! "$n" -v >/dev/null 2>&1; then
    echo "[!] Node.js binary failed ABI/OpenSSL check, repairing Termux packages..."
    if [ "$IS_ROOT" = "1" ]; then
      echo "[-] Node.js is broken and cannot be upgraded while running as root. Exit 'su' and run: loader --repair"
      return 1
    fi
    heal_dpkg
    DEBIAN_FRONTEND=noninteractive pkg_wrap upgrade -y -o Dpkg::Options::=--force-confnew 2>&1 | tail -n 4
    "$n" -v >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y --reinstall openssl nodejs >/dev/null 2>&1 || true
    if ! "$n" -v >/dev/null 2>&1; then
      use_official_mirror
      DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -o Dpkg::Options::=--force-confnew 2>&1 | tail -n 4
      DEBIAN_FRONTEND=noninteractive apt-get install -y --reinstall openssl nodejs >/dev/null 2>&1 || true
    fi
    "$n" -v >/dev/null 2>&1 || { echo "[-] Node.js still cannot start. Run manually: pkg upgrade -y"; return 1; }
    echo "[+] Node.js repaired: $("$n" -v)"
  fi
  # sqlite3 is required by both versions (cookie read / login)
  pkg_ensure sqlite || { echo "[-] sqlite3 is required (pkg install sqlite)."; return 1; }

  # optional helpers
  pkg_ensure $OPT_SYS_PKGS
  if [ "$want_vip" = "1" ]; then
    pkg_ensure $VIP_EXTRA_PKGS
  fi

  # isolated npm env (VIP only: LITE has no npm dependency)
  if [ "$want_vip" = "1" ]; then
    mkdir -p "$ENV_DIR" 2>/dev/null
    if [ ! -f "$ENV_DIR/package.json" ]; then
      cat > "$ENV_DIR/package.json" <<'EOF'
{
  "name": "roblox-rejoin-env",
  "private": true,
  "description": "Managed runtime dependencies for Roblox Rejoin VIP"
}
EOF
    fi
    if [ "$force" = "1" ] || ! node_modules_ok "$n" "$VIP_NPM_DEPS"; then
      command -v npm >/dev/null 2>&1 || pkg_ensure nodejs
      echo "[*] Installing NPM packages into isolated env: $VIP_NPM_DEPS"
      local npm_log="$TMP_DIR/npm_install.log"
      ( cd "$ENV_DIR" && npm install --save --no-audit --no-fund --prefer-offline --loglevel=error $VIP_NPM_DEPS ) >"$npm_log" 2>&1 || \
      ( cd "$ENV_DIR" && rm -rf node_modules package-lock.json && npm install --save --no-audit --no-fund --loglevel=error $VIP_NPM_DEPS ) >>"$npm_log" 2>&1 || {
        echo "[!] NPM install failed, last lines:"
        tail -n 5 "$npm_log" 2>/dev/null | sed 's/^/    /'
      }
      rm -f "$npm_log" 2>/dev/null || true
      fix_owner "$ENV_DIR"
    fi
    local crit
    for crit in $VIP_REQUIRED_MODULES; do
      if ! NODE_PATH="$ENV_DIR/node_modules" "$n" -e "require.resolve('$crit')" >/dev/null 2>&1; then
        echo "[-] Missing required NPM module '$crit'. Check internet and run: loader --repair"
        return 1
      fi
    done
    # `node rejoin.cjs` by hand should find the modules too
    if [ -d "$D" ] && [ ! -e "$D/node_modules" ]; then
      ln -s "$ENV_DIR/node_modules" "$D/node_modules" 2>/dev/null || true
    fi
  fi

  setup_autostart_files || true
  write_stamp "$ENV_STAMP_V3" "$mode" "$(entry_for_mode "$mode")"
  fix_owner "$ROBLOX_REJOIN_HOME"
  return 0
}

# Incremental environment check used on a normal start: only touches what is missing.
verify_environment() {
  local mode="$1"
  local required="$LITE_REQUIRED_MODULES"
  [ "$mode" = "1" ] && required="$VIP_REQUIRED_MODULES"

  local n
  n="$(node_bin_path)"
  if [ -z "$n" ] || ! "$n" -v >/dev/null 2>&1; then
    echo "[*] Node.js missing or broken, repairing..."
    setup_environment "$mode" "0" || return 1
    return 0
  fi
  local need_install=0
  command -v sqlite3 >/dev/null 2>&1 || { echo "[*] sqlite3 missing."; need_install=1; }
  if [ "$mode" = "1" ] && ! node_modules_ok "$n" "$required"; then
    echo "[*] Some npm modules are missing."
    need_install=1
  fi
  if [ "$need_install" = "1" ]; then
    setup_environment "$mode" "0" || return 1
  else
    # cheap: refresh the stamp so the next start takes the fast path
    write_stamp "$ENV_STAMP_V3" "$mode" "$(entry_for_mode "$mode")"
    setup_autostart_files >/dev/null 2>&1 || true
  fi
  return 0
}

# ---------------------------------------------------------------------------------------
# Autostart
# ---------------------------------------------------------------------------------------
setup_autostart_files() {
  [ "${REJOIN_NO_AUTOSTART:-0}" = "1" ] || [ -f "$AUTOSTART_OFF_PATH" ] && return 0
  local boot_dir="$REAL_HOME/.termux/boot"
  local open_comp="$TERMUX_PKG/com.termux.app.TermuxActivity"
  local q_cfg q_open q_flag q_log
  q_cfg="$(sh_quote "$ROBLOX_REJOIN_HOME")"
  q_open="$(sh_quote "$open_comp")"
  q_flag="$(sh_quote "$AUTOSTART_PENDING_PATH")"
  q_log="$(sh_quote "$BOOT_LOG_PATH")"

  mkdir -p "$boot_dir" 2>/dev/null || return 1
  cat > "$AUTOSTART_BOOT_SCRIPT.tmp" <<EOF
#!$PREFIX_DIR/bin/sh
# Roblox Rejoin: Termux:Boot autostart script (managed by loader)
CFG=$q_cfg
OPEN=$q_open
LOADER="$PREFIX_DIR/bin/loader"
FLAG="\$CFG/autostart_pending"
ST="\$CFG/boot_status.json"
LOG="\$CFG/boot.log"
[ -f "\$CFG/autostart_disabled" ] && exit 0
log() { echo "\$(date '+%m-%d %H:%M:%S') \$*" >> "\$LOG" 2>/dev/null; }
[ -f "\$LOG" ] && [ "\$(wc -c < "\$LOG" 2>/dev/null || echo 0)" -gt 65536 ] && { tail -n 200 "\$LOG" > "\$LOG.tmp" 2>/dev/null && mv -f "\$LOG.tmp" "\$LOG"; }
T0=\$(date +%s)
UP=\$(cut -d. -f1 /proc/uptime 2>/dev/null); case "\$UP" in ''|*[!0-9]*) UP=0 ;; esac
BOOT_ID=\$(cat /proc/sys/kernel/random/boot_id 2>/dev/null | tr -d '\n"\\')
st() {
  _a=\$2; [ -n "\$_a" ] || _a=0
  printf '{"stage":"%s","ts":%s,"scriptTs":%s,"bootId":"%s","bootEpoch":%s,"attempt":%s,"via":"%s","msg":"%s"}\n' "\$1" "\$(date +%s)" "\$T0" "\$BOOT_ID" "\$((T0 - UP))" "\$_a" "\$3" "\$4" > "\$ST.tmp" 2>/dev/null && mv -f "\$ST.tmp" "\$ST" 2>/dev/null
  log "\$1 \$4"
}
if [ ! -f "\$CFG/last_session.json" ] && [ ! -f "\$CFG/multi_configs.json" ]; then
  st skipped 0 "" "Nothing to resume: configure and start a package once (option 1)"
  exit 0
fi
st script_started 0 "" "Boot script started"
termux-wake-lock 2>/dev/null || true
i=0
while [ "\$(getprop sys.boot_completed 2>/dev/null)" != "1" ] && [ "\$i" -lt 60 ]; do sleep 2; i=\$((i + 1)); done
sleep 10

open_termux() {
  _t=""; command -v timeout >/dev/null 2>&1 && _t="timeout 25"
  if command -v su >/dev/null 2>&1; then
    \$_t su -c "unset LD_PRELOAD LD_LIBRARY_PATH; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard; /system/bin/am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n \$OPEN" >/dev/null 2>&1 && return 0
  fi
  am start -n "\$OPEN" >/dev/null 2>&1
}

n=0; opened=0
while [ "\$n" -lt 5 ]; do
  n=\$((n + 1))
  date +%s > "\$FLAG" 2>/dev/null
  st opening_termux "\$n" termux "Opening Termux (try \$n/5)"
  open_termux
  w=0
  while [ "\$w" -lt 30 ] && [ -f "\$FLAG" ]; do sleep 2; w=\$((w + 2)); done
  if [ ! -f "\$FLAG" ]; then opened=1; break; fi
  log "try \$n: Termux did not start a shell in 30s"
done

if [ "\$opened" = 1 ]; then
  grep -q '"stage":"opening_termux"' "\$ST" 2>/dev/null && st termux_opened "\$n" termux "Termux opened, starting the tool"
  exit 0
fi

if mv "\$FLAG" "\$FLAG.fb" 2>/dev/null; then
  rm -f "\$FLAG.fb"
  if [ ! -x "\$LOADER" ]; then st failed "\$n" headless "loader command not found"; exit 1; fi
  st headless "\$n" headless "Termux could not be opened, running in background"
  "\$LOADER" --autostart --no-update < /dev/null 2>&1 | { head -n 300 > "\$CFG/autostart.log"; cat > /dev/null; }
  grep -q '"stage":"failed"' "\$ST" 2>/dev/null || st stopped "\$n" headless "The tool exited"
fi
exit 0
EOF
  # skip the rewrite when nothing changed: the fast path calls this on every start and a
  # unchanged boot script must not cost a disk write (flash wear on long-lived devices)
  if [ -f "$AUTOSTART_BOOT_SCRIPT" ] && cmp -s "$AUTOSTART_BOOT_SCRIPT.tmp" "$AUTOSTART_BOOT_SCRIPT"; then
    rm -f "$AUTOSTART_BOOT_SCRIPT.tmp" 2>/dev/null || true
  else
    mv -f "$AUTOSTART_BOOT_SCRIPT.tmp" "$AUTOSTART_BOOT_SCRIPT" 2>/dev/null || return 0
  fi
  chmod 755 "$AUTOSTART_BOOT_SCRIPT" 2>/dev/null || true

  # only rewrite the rc files when the managed block is missing or outdated.
  # The check runs on a normal (fast) start too, so it stays cheap: one grep per rc file.
  local rc_file tmp_rc block_needed=0 env_q
  env_q="NODE_PATH=\"$ENV_DIR/node_modules\""
  for rc_name in .bashrc .zshrc; do
    rc_file="$REAL_HOME/$rc_name"
    [ "$rc_name" = ".zshrc" ] && [ ! -f "$rc_file" ] && continue
    if ! grep -qF "$RC_BEGIN" "$rc_file" 2>/dev/null || ! grep -qF "$env_q" "$rc_file" 2>/dev/null; then
      block_needed=1
      break
    fi
  done
  if [ "$block_needed" = "0" ] && [ -f "$AUTOSTART_ARMED_PATH" ]; then
    return 0
  fi

  for rc_name in .bashrc .zshrc; do
    rc_file="$REAL_HOME/$rc_name"
    [ "$rc_name" = ".zshrc" ] && [ ! -f "$rc_file" ] && continue
    touch "$rc_file" 2>/dev/null || continue
    tmp_rc="$rc_file.rj_tmp"
    awk -v b="$RC_BEGIN" -v e="$RC_END" '
      $0 == b { skip=1; next }
      $0 == e { skip=0; next }
      $0 == "# >>> roblox-rejoin autostart (managed by the tool) >>>" { skip=1; next }
      $0 == "# <<< roblox-rejoin autostart <<<" { skip=0; next }
      !skip { print }
    ' "$rc_file" > "$tmp_rc" 2>/dev/null || continue
    cat >> "$tmp_rc" <<EOF
$RC_BEGIN
export PATH="$TERMUX_BIN:\$PATH"
export NODE_PATH="$ENV_DIR/node_modules"
export ROBLOX_REJOIN_HOME="$ROBLOX_REJOIN_HOME"
export ROBLOX_REJOIN_ENV="$ENV_DIR"
export ROBLOX_REJOIN_TMP="$TMP_DIR"
if [ -f $q_flag ] && [ -t 0 ]; then
  if mv $q_flag ${q_flag}.run 2>/dev/null; then
    _rj_ts=\$(cat ${q_flag}.run 2>/dev/null); rm -f ${q_flag}.run
    case "\$_rj_ts" in
      ''|*[!0-9]*) ;;
      *) if [ \$(( \$(date +%s) - _rj_ts )) -lt 900 ]; then
           echo "\$(date '+%m-%d %H:%M:%S') hook: Termux shell opened, starting loader" >> $q_log 2>/dev/null
           if command -v loader >/dev/null 2>&1; then loader --autostart --no-update; else "$L" --autostart --no-update; fi
         fi ;;
    esac
    unset _rj_ts
  fi
fi
$RC_END
EOF
    mv -f "$tmp_rc" "$rc_file" 2>/dev/null || rm -f "$tmp_rc"
  done

  [ -f "$AUTOSTART_ARMED_PATH" ] || date +%s > "$AUTOSTART_ARMED_PATH" 2>/dev/null || true
  fix_owner "$REAL_HOME/.termux" "$REAL_HOME/.bashrc" "$REAL_HOME/.zshrc" "$AUTOSTART_ARMED_PATH"
  return 0
}

remove_autostart_files() {
  rm -f "$AUTOSTART_BOOT_SCRIPT" "$AUTOSTART_PENDING_PATH" "$AUTOSTART_PENDING_PATH.run" "$AUTOSTART_PENDING_PATH.fb" "$AUTOSTART_ARMED_PATH" 2>/dev/null || true
  local rc_name rc_file
  for rc_name in .bashrc .zshrc; do
    rc_file="$REAL_HOME/$rc_name"
    [ -f "$rc_file" ] || continue
    awk -v b="$RC_BEGIN" -v e="$RC_END" '
      $0 == b || $0 == "# >>> roblox-rejoin autostart (managed by the tool) >>>" { skip=1; next }
      $0 == e || $0 == "# <<< roblox-rejoin autostart <<<" { skip=0; next }
      !skip { print }
    ' "$rc_file" > "$rc_file.rj_tmp" 2>/dev/null && mv -f "$rc_file.rj_tmp" "$rc_file"
  done
}

print_boot_status_fast() {
  echo
  echo "=== Roblox Rejoin - Boot & Environment Status ==="
  printf "  %-18s: %s\n" "Autostart" "$([ -f "$AUTOSTART_OFF_PATH" ] && echo "OFF (enable: loader --autostart-on)" || echo "ON")"
  printf "  %-18s: %s\n" "Boot script" "$([ -x "$AUTOSTART_BOOT_SCRIPT" ] && echo "OK ($AUTOSTART_BOOT_SCRIPT)" || echo "MISSING")"
  printf "  %-18s: %s\n" "Shell hook" "$(grep -qF "roblox-rejoin autostart" "$REAL_HOME/.bashrc" 2>/dev/null && echo "OK (~/.bashrc)" || echo "MISSING")"
  printf "  %-18s: %s\n" "Saved session" "$([ -f "$ROBLOX_REJOIN_HOME/last_session.json" ] && echo "OK (last_session.json)" || echo "None yet")"
  printf "  %-18s: %s\n" "Node.js" "$(command -v node >/dev/null 2>&1 && node -v 2>/dev/null || echo "NOT INSTALLED")"
  printf "  %-18s: %s\n" "SQLite3" "$(command -v sqlite3 >/dev/null 2>&1 && sqlite3 --version 2>/dev/null | cut -d' ' -f1 || echo "NOT INSTALLED")"
  printf "  %-18s: %s\n" "Env stamp" "$([ -f "$ENV_STAMP_V3" ] && echo "OK (fast start)" || echo "MISSING (run loader --repair)")"
  printf "  %-18s: %s\n" "Repo check" "$([ -f "$UPDATE_STAMP_FILE" ] && echo "$(( ($(now_s) - $(cat "$UPDATE_STAMP_FILE" 2>/dev/null | tr -dc '0-9' || echo 0)) / 60 ))m ago" || echo "never")"
  printf "  %-18s: %s\n" "Wake-lock API" "$(command -v termux-wake-lock >/dev/null 2>&1 && echo "OK" || echo "MISSING (pkg install termux-api)")"
  if [ -f "$HEARTBEAT_PATH" ]; then
    local hb now age
    hb="$(cat "$HEARTBEAT_PATH" 2>/dev/null | tr -dc '0-9')"
    now="$(now_s)"
    age=$((now - ${hb:-0}))
    printf "  %-18s: %s\n" "Monitor alive" "$([ "$age" -lt 150 ] && echo "YES (${age}s ago)" || echo "NO (last beat ${age}s ago)")"
  fi
  if [ -f "$BOOT_STATUS_PATH" ]; then
    printf "  %-18s: %s\n" "Boot status JSON" "$(cat "$BOOT_STATUS_PATH" 2>/dev/null | tr -d '\n')"
  fi
  echo
  echo "Recent boot log ($BOOT_LOG_PATH):"
  if [ -s "$BOOT_LOG_PATH" ]; then
    tail -n 10 "$BOOT_LOG_PATH" | sed 's/^/  /'
  else
    echo "  (empty)"
  fi
  echo
}

show_help() {
  cat <<'EOF'
Usage: loader [1|vip|2|lite] [options]

Options:
  1, vip             Start VIP version (rejoin.cjs)
  2, lite            Start LITE version (rejoin lite.cjs)
  --repair, --env    Check & reinstall all system + NPM dependencies
  --no-update        Skip git/tarball update on this launch
  --update           Force a repo update on this launch
  --boot-status      Display autostart & environment status
  --autostart-on     Enable auto-start on device reboot
  --autostart-off    Disable auto-start on device reboot
  -h, --help         Show this help message
EOF
}

# runs before any menu; configs are migrated later inside sync_repo, right before a reset
install_self

# Parse flags cleanly before showing any menu
AUTOSTART=0
NO_UPDATE=0
FORCE_UPDATE=0
REPAIR_ONLY=0
CHOICE=""
PASS_ARGS=()

normalize_choice() {
  case "$(printf "%s" "${1:-}" | tr 'A-Z' 'a-z')" in
    1|vip) echo 1 ;;
    2|lite) echo 2 ;;
    3|repair|env) echo 3 ;;
    *) echo "" ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) show_help; exit 0 ;;
    --autostart) AUTOSTART=1 ;;
    --no-update|--offline) NO_UPDATE=1 ;;
    --update) FORCE_UPDATE=1 ;;
    --repair|--env|--setup-env) REPAIR_ONLY=1 ;;
    --autostart-off)
      echo "1" > "$AUTOSTART_OFF_PATH"
      remove_autostart_files
      echo "[+] Auto start on reboot is OFF."
      exit 0
      ;;
    --autostart-on)
      rm -f "$AUTOSTART_OFF_PATH" "$AUTOSTART_ARMED_PATH" 2>/dev/null || true
      if setup_autostart_files; then
        echo "[+] Auto start on reboot is ON (install Termux:Boot and open it once)."
      else
        echo "[-] Failed to write autostart files."
        exit 1
      fi
      exit 0
      ;;
    --boot-status)
      # node prints the authoritative report (boot_status.json + boot.log); shell summary is the
      # fallback when node is missing or the entry file was not downloaded yet
      if command -v node >/dev/null 2>&1 && [ -f "$D/$ENTRY_VIP" ]; then
        exec node "$D/$ENTRY_VIP" --boot-status
      fi
      print_boot_status_fast
      exit 0
      ;;
    *)
      if [ -z "$CHOICE" ]; then
        _c="$(normalize_choice "$1")"
        if [ -n "$_c" ]; then
          [ "$_c" = "3" ] && REPAIR_ONLY=1 || CHOICE="$_c"
          shift
          continue
        fi
      fi
      PASS_ARGS+=("$1")
      ;;
  esac
  shift
done

# Handle standalone --repair mode
if [ "$REPAIR_ONLY" = "1" ]; then
  sync_repo "1" || true
  if setup_environment "repair" "1"; then
    echo "[+] Environment check & repair completed!"
    print_boot_status_fast
    exit 0
  else
    echo "[-] Environment repair encountered errors."
    exit 1
  fi
fi

LAST="$(cat "$LAST_FILE" 2>/dev/null | tr -dc '12')"
case "$LAST" in 1|2) ;; *) LAST=1 ;; esac

if [ "$AUTOSTART" = "1" ]; then
  CHOICE="$LAST"
fi

# Interactive Loader Menu
if [ -z "$CHOICE" ]; then
  C1=$'\033[1;38;5;87m'; C2=$'\033[1;38;5;121m'; C3=$'\033[38;5;245m'; C4=$'\033[38;5;63m'; C5=$'\033[1;38;5;221m'; C0=$'\033[0m'
  [ -t 1 ] || { C1=""; C2=""; C3=""; C4=""; C5=""; C0=""; }
  echo
  echo "${C4}╭─ ${C1}ROBLOX REJOIN LOADER${C4} ─────────────────────────────╮${C0}"
  echo "${C4}│${C0}                                                    ${C4}│${C0}"
  echo "${C4}│${C0}  ${C2}[1]${C0} VIP        ${C3}Full UI, themes, world scan, exec${C0}  ${C4}│${C0}"
  echo "${C4}│${C0}  ${C2}[2]${C0} LITE       ${C3}Zero-npm, ultra-low RAM long runs${C0}  ${C4}│${C0}"
  echo "${C4}│${C0}  ${C5}[3]${C0} REPAIR     ${C3}Reinstall / verify environment${C0}     ${C4}│${C0}"
  echo "${C4}│${C0}                                                    ${C4}│${C0}"
  echo "${C4}╰────────────────────────────────────────────────────╯${C0}"
  printf "  Choose [1-3, Enter = %s]: " "$LAST"
  ANS=""
  { read -r ANS </dev/tty; } 2>/dev/null || read -r ANS || ANS=""
  if [ -z "$ANS" ]; then
    CHOICE="$LAST"
  else
    CHOICE="$(normalize_choice "$ANS")"
    if [ "$CHOICE" = "3" ]; then
      sync_repo "1" || true
      setup_environment "repair" "1"
      exit $?
    fi
    [ -z "$CHOICE" ] && { echo "[-] Invalid choice."; exit 1; }
  fi
fi

echo "$CHOICE" > "$LAST_FILE" 2>/dev/null || true
fix_owner "$LAST_FILE"
if [ "$CHOICE" = "2" ]; then ENTRY="$ENTRY_LITE"; NAME="LITE"; else ENTRY="$ENTRY_VIP"; NAME="VIP"; fi

# ---------------------------------------------------------------------------------------
# Fast path: everything verified after the last change of the entry script -> no checks at all
# ---------------------------------------------------------------------------------------
FAST=0
if [ "$FORCE_UPDATE" = "0" ] && [ "$NO_UPDATE" = "0" ] && fast_ready "$CHOICE"; then
  FAST=1
  # still refresh autostart here: a boot script left by an older version must not keep launching
  # the stale copy after a reboot (cheap: a couple of cmp/writes, failures ignored)
  setup_autostart_files >/dev/null 2>&1 || true
fi

if [ "$FAST" = "0" ]; then
  echo "[*] Preparing $NAME..."
  sync_repo "$FORCE_UPDATE" || exit 1

  # Self-update loader if repository has a newer loader.sh
  if [ -z "${LOADER_REEXEC:-}" ] && [ -f "$D/loader.sh" ] && [ -f "$L" ] && ! cmp -s "$D/loader.sh" "$L"; then
    if cp -f "$D/loader.sh" "$L" 2>/dev/null && sed -i 's/\r$//' "$L" 2>/dev/null && chmod 755 "$L" 2>/dev/null; then
      fix_owner "$L"
      echo "[*] Loader updated, restarting..."
      if [ "$AUTOSTART" = "1" ]; then
        LOADER_REEXEC=1 exec bash "$L" --autostart --no-update "${PASS_ARGS[@]+"${PASS_ARGS[@]}"}"
      else
        LOADER_REEXEC=1 exec bash "$L" "$CHOICE" --no-update "${PASS_ARGS[@]+"${PASS_ARGS[@]}"}"
      fi
    fi
  fi

  verify_environment "$CHOICE" || exit 1
fi

N="$(node_bin_path)"
[ -n "$N" ] || { echo "[-] Node.js is not available."; exit 1; }

[ ! -f "$D/$ENTRY" ] && { echo "[-] Entry file '$ENTRY' not found in $D"; exit 1; }

cd "$D" || exit 1
if [ "$AUTOSTART" = "1" ]; then
  exec "$N" "$ENTRY" --autostart "${PASS_ARGS[@]+"${PASS_ARGS[@]}"}"
else
  exec "$N" "$ENTRY" "${PASS_ARGS[@]+"${PASS_ARGS[@]}"}"
fi
