#!/bin/bash
# loader.sh - Environment installer, updater, autostart manager & launcher for Roblox Rejoin (VIP & LITE)
# Usage:
#   loader                   -> interactive menu (1 = VIP, 2 = LITE, 3 = Repair Env)
#   loader 1|vip [args...]   -> run VIP directly
#   loader 2|lite [args...]  -> run LITE directly
#   loader --repair          -> force check & install all Termux + NPM dependencies
#   loader --boot-status     -> show reboot autostart diagnostics
#   loader --autostart-on    -> enable Termux:Boot + shell autostart
#   loader --autostart-off   -> disable Termux:Boot + shell autostart
#   loader --no-update       -> skip git/tarball update on this run
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
W="$D"
ENTRY_VIP="rejoin.cjs"
ENTRY_LITE="rejoin lite.cjs"
L="$TERMUX_BIN/loader"

# Persistent config & isolated NPM environment outside the git repo
ROBLOX_REJOIN_HOME="${ROBLOX_REJOIN_HOME:-$REAL_HOME/.roblox-rejoin}"
ENV_DIR="$ROBLOX_REJOIN_HOME/env"
TMP_DIR="$ROBLOX_REJOIN_HOME/tmp"
export ROBLOX_REJOIN_HOME
export NODE_PATH="$ENV_DIR/node_modules"

mkdir -p "$ROBLOX_REJOIN_HOME" "$ENV_DIR" "$TMP_DIR" 2>/dev/null
chmod 700 "$TMP_DIR" 2>/dev/null || true

CFGS="multi_configs.json webhook_config.json package_prefix_config.json activity_config.json autoexec_config.json ui_config.json run_options.json last_session.json"
LAST_FILE="$ROBLOX_REJOIN_HOME/loader_choice"
ENV_STAMP_FILE="$ENV_DIR/.env_ok_v2"
VIP_DEPS="axios cli-table3 figlet"

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

pkg_wrap() { yes | command pkg "$@"; }

sh_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

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

# Migrate legacy configs out of the git repo before any reset/clean
save_old_configs() {
  [ -d "$D" ] || return 0
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

# Write Termux:Boot script & ~/.bashrc / ~/.zshrc autostart hook
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
  "\$LOADER" --autostart < /dev/null 2>&1 | { head -n 300 > "\$CFG/autostart.log"; cat > /dev/null; }
  grep -q '"stage":"failed"' "\$ST" 2>/dev/null || st stopped "\$n" headless "The tool exited"
fi
exit 0
EOF
  mv -f "$AUTOSTART_BOOT_SCRIPT.tmp" "$AUTOSTART_BOOT_SCRIPT"
  chmod 755 "$AUTOSTART_BOOT_SCRIPT" 2>/dev/null || true

  local rc_file tmp_rc
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
if [ -f $q_flag ] && [ -t 0 ]; then
  if mv $q_flag ${q_flag}.run 2>/dev/null; then
    _rj_ts=\$(cat ${q_flag}.run 2>/dev/null); rm -f ${q_flag}.run
    case "\$_rj_ts" in
      ''|*[!0-9]*) ;;
      *) if [ \$(( \$(date +%s) - _rj_ts )) -lt 900 ]; then
           echo "\$(date '+%m-%d %H:%M:%S') hook: Termux shell opened, starting loader" >> $q_log 2>/dev/null
           if command -v loader >/dev/null 2>&1; then loader --autostart; else "$L" --autostart; fi
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
  for rc_name in .bashrc .zshrc; do
    local rc_file="$REAL_HOME/$rc_name"
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
  printf "  %-18s: %s\n" "Wake-lock API" "$(command -v termux-wake-lock >/dev/null 2>&1 && echo "OK" || echo "MISSING (pkg install termux-api)")"
  if [ -f "$HEARTBEAT_PATH" ]; then
    local hb now age
    hb="$(cat "$HEARTBEAT_PATH" 2>/dev/null | tr -dc '0-9')"
    now="$(date +%s)"
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
  --boot-status      Display autostart & environment status
  --autostart-on     Enable auto-start on device reboot
  --autostart-off    Disable auto-start on device reboot
  -h, --help         Show this help message
EOF
}

install_self
save_old_configs

# Parse flags cleanly before showing any menu
AUTOSTART=0
NO_UPDATE=0
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
      # If node + VIP/LITE exist, let cjs print detailed status, else use fast shell status
      if command -v node >/dev/null 2>&1 && [ -f "$D/$ENTRY_VIP" ]; then
        exec node "$D/$ENTRY_VIP" --boot-status
      else
        print_boot_status_fast
        exit 0
      fi
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

# Mirror & APT recovery helpers
use_official_mirror() {
  echo "[*] Switching Termux mirror to packages.termux.dev..."
  rm -f "$PREFIX_DIR/etc/termux/chosen_mirrors" 2>/dev/null || true
  mkdir -p "$PREFIX_DIR/etc/apt" 2>/dev/null || true
  echo "deb https://packages.termux.dev/apt/termux-main stable main" > "$PREFIX_DIR/etc/apt/sources.list"
  rm -rf "$PREFIX_DIR/var/lib/apt/lists/"* 2>/dev/null || true
}

heal_dpkg() {
  [ "$IS_ROOT" = "1" ] && return 0
  dpkg --configure -a >/dev/null 2>&1 || true
}

pkg_install() {
  if [ "$IS_ROOT" = "1" ]; then
    echo "[!] Running as root: Termux pkg/apt cannot run under UID 0."
    echo "    Exit 'su' and run 'loader --repair' as the normal Termux user to install: $*"
    return 1
  fi
  heal_dpkg
  DEBIAN_FRONTEND=noninteractive pkg_wrap update >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive pkg_wrap install -y "$@" && return 0
  echo "[!] Retrying install ($*) with apt-get --fix-missing..."
  heal_dpkg
  apt-get update >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y --fix-missing "$@" && return 0
  use_official_mirror
  apt-get update >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y --fix-missing "$@" && return 0
  return 1
}

# Complete Environment Installer (System packages + Node ABI + Isolated NPM modules)
setup_environment() {
  local mode="${1:-1}" # 1 = VIP (full), 2 = LITE, repair = everything
  local force="${2:-0}"

  echo "[*] Checking Termux runtime environment..."

  # 1. Core download / archive utilities
  if ! command -v git >/dev/null 2>&1 && ! command -v curl >/dev/null 2>&1; then
    echo "[*] Installing curl & git..."
    pkg_install curl git tar || true
  fi
  command -v tar >/dev/null 2>&1 || pkg_install tar || true

  # 2. Node.js + OpenSSL ABI check
  local node_bin="$TERMUX_BIN/node"
  [ ! -x "$node_bin" ] && node_bin="$(command -v node 2>/dev/null || echo "")"
  if [ -z "$node_bin" ]; then
    echo "[*] Installing nodejs..."
    pkg_install nodejs || { echo "[-] Could not install nodejs."; return 1; }
    node_bin="$(command -v node 2>/dev/null || echo "$TERMUX_BIN/node")"
  fi

  if ! "$node_bin" -v >/dev/null 2>&1; then
    echo "[!] Node.js binary failed ABI/OpenSSL check, repairing Termux packages..."
    if [ "$IS_ROOT" = "1" ]; then
      echo "[-] Node.js is broken and cannot be upgraded while running as root. Exit 'su' and run: loader --repair"
      return 1
    fi
    heal_dpkg
    pkg_wrap update >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive pkg_wrap upgrade -y -o Dpkg::Options::=--force-confnew 2>&1 | tail -n 4
    "$node_bin" -v >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y --reinstall openssl nodejs >/dev/null 2>&1 || true
    if ! "$node_bin" -v >/dev/null 2>&1; then
      use_official_mirror
      apt-get update >/dev/null 2>&1 || true
      DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -o Dpkg::Options::=--force-confnew 2>&1 | tail -n 4
      DEBIAN_FRONTEND=noninteractive apt-get install -y --reinstall openssl nodejs >/dev/null 2>&1 || true
    fi
    "$node_bin" -v >/dev/null 2>&1 || { echo "[-] Node.js still cannot start. Run manually: pkg upgrade -y"; return 1; }
    echo "[+] Node.js repaired: $("$node_bin" -v)"
  fi
  N="$node_bin"

  # 3. SQLite3 (required by both VIP & LITE for cookie read/login)
  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "[*] Installing sqlite..."
    pkg_install sqlite || { echo "[-] sqlite3 is required. Run 'pkg install sqlite' as normal Termux user."; return 1; }
  fi

  # 4. Termux:API (wake-lock), procps (pidof), nano (VIP script editor)
  command -v termux-wake-lock >/dev/null 2>&1 || {
    [ "$force" = "1" ] || [ ! -f "$ENV_STAMP_FILE" ] && pkg_install termux-api >/dev/null 2>&1 || true
  }
  if [ ! -x "/system/bin/pidof" ] && ! command -v pidof >/dev/null 2>&1; then
    pkg_install procps >/dev/null 2>&1 || true
  fi
  if [ "$mode" = "1" ] || [ "$mode" = "repair" ]; then
    command -v nano >/dev/null 2>&1 || {
      [ "$force" = "1" ] || [ ! -f "$ENV_STAMP_FILE" ] && pkg_install nano >/dev/null 2>&1 || true
    }
  fi

  # 5. Isolated NPM packages for VIP (axios, cli-table3, figlet) inside $ENV_DIR
  if [ "$mode" = "1" ] || [ "$mode" = "repair" ]; then
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

    local missing_npm=""
    for m in $VIP_DEPS; do
      if [ "$force" = "1" ] || ! NODE_PATH="$ENV_DIR/node_modules" "$N" -e "require.resolve('$m')" >/dev/null 2>&1; then
        missing_npm="$missing_npm $m"
      fi
    done

    if [ -n "$missing_npm" ]; then
      echo "[*] Installing NPM packages into isolated env:$missing_npm"
      if ! command -v npm >/dev/null 2>&1; then
        pkg_install nodejs || true
      fi
      # shellcheck disable=SC2086
      (cd "$ENV_DIR" && npm install --save --no-audit --no-fund --prefer-offline $missing_npm) || \
      (cd "$ENV_DIR" && rm -rf node_modules package-lock.json && npm install --save --no-audit --no-fund $missing_npm) || {
        echo "[!] NPM install encountered an error."
      }
      fix_owner "$ENV_DIR"
    fi

    # Verify critical VIP dependencies (axios & cli-table3; figlet has a built-in fallback)
    for crit in axios cli-table3; do
      if ! NODE_PATH="$ENV_DIR/node_modules" "$N" -e "require('$crit')" >/dev/null 2>&1; then
        echo "[-] Missing required NPM module '$crit'. Check internet and run: loader --repair"
        return 1
      fi
    done

    # Link $D/node_modules -> $ENV_DIR/node_modules so running `node rejoin.cjs` directly also works
    if [ -d "$D" ] && [ ! -e "$D/node_modules" ]; then
      ln -s "$ENV_DIR/node_modules" "$D/node_modules" 2>/dev/null || true
    fi
  fi

  # 6. Configure autostart scripts & PATH exports
  setup_autostart_files || true
  date +%s > "$ENV_STAMP_FILE" 2>/dev/null || true
  fix_owner "$ROBLOX_REJOIN_HOME"
  return 0
}

download_tarball() {
  local tmp_dl url
  tmp_dl="$(mktemp -d 2>/dev/null || echo "$TMP_DIR/dl_$$")"
  mkdir -p "$tmp_dl"
  url="$R/archive/refs/heads/main.tar.gz"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --connect-timeout 10 --retry 2 -o "$tmp_dl/r.tgz" "$url" || { rm -rf "$tmp_dl"; return 1; }
  elif command -v wget >/dev/null 2>&1; then
    wget -T 15 -O "$tmp_dl/r.tgz" "$url" || { rm -rf "$tmp_dl"; return 1; }
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

sync_repo() {
  save_old_configs
  if [ "$AUTOSTART" = "1" ] && [ -d "$D" ] && { [ -f "$D/$ENTRY_VIP" ] || [ -f "$D/$ENTRY_LITE" ]; }; then
    echo "[*] Autostart mode — using existing local files."
    return 0
  fi
  if [ "$NO_UPDATE" = "1" ] && [ -d "$D" ]; then
    echo "[*] Skipping repo update (--no-update)."
    return 0
  fi

  local use_tar=0
  if ! command -v git >/dev/null 2>&1; then
    pkg_install git || use_tar=1
  fi

  if [ "$use_tar" = "1" ]; then
    if ! download_tarball; then
      if [ -f "$D/$ENTRY_VIP" ] || [ -f "$D/$ENTRY_LITE" ]; then
        echo "[!] Update download failed — continuing with local version."
        return 0
      fi
      echo "[-] Could not download repository. Check your internet connection."
      return 1
    fi
  elif [ ! -d "$D/.git" ]; then
    if [ -f "$D/$ENTRY_VIP" ] && [ "$IS_ROOT" = "1" ]; then
      echo "[*] Running existing local files in $D."
      return 0
    fi
    local tmp_clone="$D.clone_$$"
    rm -rf "$tmp_clone" 2>/dev/null || true
    if git clone --depth 1 "$R" "$tmp_clone"; then
      rm -rf "$D" 2>/dev/null || true
      mv "$tmp_clone" "$D"
      fix_owner "$D"
    else
      rm -rf "$tmp_clone" 2>/dev/null || true
      echo "[!] git clone failed, trying tarball..."
      if ! download_tarball; then
        [ -f "$D/$ENTRY_VIP" ] && { echo "[!] Using existing local copy."; return 0; }
        return 1
      fi
    fi
  else
    (
      cd "$D" || exit 1
      cur="$(git remote get-url origin 2>/dev/null || echo "")"
      [ "$cur" != "$R" ] && git remote set-url origin "$R" 2>/dev/null || true
      if git fetch --depth 1 origin main >/dev/null 2>&1 || git fetch --all --prune >/dev/null 2>&1; then
        excl="-e node_modules"
        for f in $CFGS; do excl="$excl -e $f"; done
        git reset --hard origin/main >/dev/null 2>&1 || git reset --hard FETCH_HEAD >/dev/null 2>&1 || true
        # shellcheck disable=SC2086
        git clean -fd $excl >/dev/null 2>&1 || true
      else
        echo "[!] Network/GitHub unreachable — continuing with local version."
      fi
    )
    fix_owner "$D"
  fi
  return 0
}

# Handle standalone --repair mode
if [ "$REPAIR_ONLY" = "1" ]; then
  sync_repo || true
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
elif [ -z "$CHOICE" ]; then
  CHOICE="$(normalize_choice "${LOADER_CHOICE:-}")"
  [ "$CHOICE" = "3" ] && CHOICE=""
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
      sync_repo || true
      setup_environment "repair" "1"
      exit $?
    fi
    [ -z "$CHOICE" ] && { echo "[-] Invalid choice."; exit 1; }
  fi
fi

echo "$CHOICE" > "$LAST_FILE" 2>/dev/null || true
fix_owner "$LAST_FILE"
if [ "$CHOICE" = "2" ]; then ENTRY="$ENTRY_LITE"; NAME="LITE"; else ENTRY="$ENTRY_VIP"; NAME="VIP"; fi
echo "[*] Preparing $NAME..."

sync_repo || exit 1

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

# Ensure full runtime environment before launching Node
setup_environment "$CHOICE" "0" || exit 1

if [ -d "$D" ] && [ ! -e "$D/node_modules" ] && [ -d "$ENV_DIR/node_modules" ]; then
  ln -s "$ENV_DIR/node_modules" "$D/node_modules" 2>/dev/null || true
fi

[ ! -f "$W/$ENTRY" ] && { echo "[-] Entry file '$ENTRY' not found in $W"; exit 1; }

cd "$W" || exit 1
if [ "$AUTOSTART" = "1" ]; then
  exec "$N" "$ENTRY" --autostart "${PASS_ARGS[@]+"${PASS_ARGS[@]}"}"
else
  exec "$N" "$ENTRY" "${PASS_ARGS[@]+"${PASS_ARGS[@]}"}"
fi
