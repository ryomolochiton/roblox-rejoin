#!/bin/bash
# loader.sh — Termux bootstrap for Roblox Rejoin.
# Sets up everything the tool needs on a clean device, then runs VIP or LITE.
# usage: loader          -> menu (1 = VIP, 2 = LITE)
#        loader 1|vip    -> run VIP directly
#        loader 2|lite   -> run LITE directly
#        loader --check  -> verify the environment only, don't start the tool
#        loader --autostart [1|2] -> boot mode: no menu, no network update
set -u

pkg(){ yes | command pkg "$@"; }

R="https://github.com/ryomolochiton/roblox-rejoin"
D="$HOME/roblox-rejoin"
W="$D"
ENTRY_VIP="rejoin.cjs"
ENTRY_LITE="rejoin lite.cjs"   # the file name has a space
L="/data/data/com.termux/files/usr/bin/loader"
PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"
TBIN="$PREFIX_DIR/bin"

N="/data/data/com.termux/files/usr/bin/node"
SS="$HOME/.roblox-rejoin/loader.state"

# config lives outside the repo so git reset / clean can't wipe it
ROBLOX_REJOIN_HOME="${ROBLOX_REJOIN_HOME:-$HOME/.roblox-rejoin}"
export ROBLOX_REJOIN_HOME
mkdir -p "$ROBLOX_REJOIN_HOME"

CFGS="multi_configs.json webhook_config.json package_prefix_config.json activity_config.json autoexec_config.json launch_activity_cache.json"
LAST_FILE="$ROBLOX_REJOIN_HOME/loader_choice"

# npm packages the tool requires at runtime (VIP only: LITE has no dependencies)
NPM_REQ="axios cli-table3 figlet"
# Termux packages the tool calls at runtime
PKG_REQ="nodejs-lts sqlite termux-api termux-boot coreutils termux-tools"

# install itself as the `loader` command, refresh it when the content differs
SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
if [ "$SELF" != "$L" ] && { [ ! -f "$L" ] || ! cmp -s "$SELF" "$L"; }; then
  cp "$SELF" "$L" 2>/dev/null && sed -i 's/\r$//' "$L" && chmod +x "$L"
fi

# pick a version
LAST="$(cat "$LAST_FILE" 2>/dev/null)"
case "$LAST" in 1|2) ;; *) LAST=1 ;; esac

# autostart mode (called by the Termux:Boot script after a reboot or crash):
#   - strips --autostart from "$@" so it doesn't confuse normalize()
#   - skips the git update (network unavailable at boot, tool already up-to-date)
#   - skips the interactive menu, uses the last saved choice
#   - re-injects --autostart when exec'ing node at the end
AUTOSTART=0
CHECK_ONLY=0
_rebuild=()
for _a in "$@"; do
  case "$_a" in
    --autostart) AUTOSTART=1; continue ;;
    --check|--doctor) CHECK_ONLY=1; continue ;;
  esac
  _rebuild+=("$_a")
done
set -- "${_rebuild[@]+"${_rebuild[@]}"}"
unset _a _rebuild

normalize() {
  case "$(echo "${1:-}" | tr 'A-Z' 'a-z')" in
    1|vip) echo 1 ;;
    2|lite) echo 2 ;;
    *) echo "" ;;
  esac
}

CHOICE=""
# autostart: use the last saved choice, no menu
if [ "$AUTOSTART" = "1" ]; then
  CHOICE="$LAST"
else
  # first argument: vip / lite / 1 / 2 (only when it is one of those, never a tool flag)
  if [ $# -gt 0 ] && [ -n "$(normalize "$1")" ]; then
    CHOICE="$(normalize "$1")"
    [ -n "$CHOICE" ] && shift
  fi
  # or the environment variable
  [ -z "$CHOICE" ] && CHOICE="$(normalize "${LOADER_CHOICE:-}")"
fi

# otherwise show the menu
if [ -z "$CHOICE" ] && [ "$CHECK_ONLY" != "1" ]; then
  C1=$'\033[1;38;5;87m'; C2=$'\033[1;38;5;121m'; C3=$'\033[38;5;245m'; C4=$'\033[38;5;63m'; C0=$'\033[0m'
  [ -t 1 ] || { C1=""; C2=""; C3=""; C4=""; C0=""; }
  echo
  echo "${C4}╭─ ${C1}ROBLOX REJOIN${C4} ────────────────────────────────────╮${C0}"
  echo "${C4}│${C0}                                                    ${C4}│${C0}"
  echo "${C4}│${C0}  ${C2}[1]${C0} VIP        ${C3}all features (rejoin.cjs)${C0}          ${C4}│${C0}"
  echo "${C4}│${C0}  ${C2}[2]${C0} LITE       ${C3}light, smooth on long runs${C0}         ${C4}│${C0}"
  echo "${C4}│${C0}                                                    ${C4}│${C0}"
  echo "${C4}╰────────────────────────────────────────────────────╯${C0}"
  printf "  Choose [1-2, Enter = %s]: " "$LAST"
  ANS=""
  # no TTY (boot / cron / piped stdin): fall back to the saved choice instead of prompting
  if { exec 9</dev/tty; } 2>/dev/null; then
    read -r ANS <&9 2>/dev/null || ANS=""
    exec 9<&- 2>/dev/null
  elif [ -t 0 ]; then
    read -r ANS || ANS=""
  fi
  if [ -z "$ANS" ]; then
    CHOICE="$LAST"
  else
    CHOICE="$(normalize "$ANS")"
    [ -z "$CHOICE" ] && { echo "[-] Invalid choice."; exit 1; }
  fi
fi

[ -n "$CHOICE" ] && echo "$CHOICE" > "$LAST_FILE" 2>/dev/null
if [ "$CHOICE" = "2" ]; then ENTRY="$ENTRY_LITE"; NAME="LITE"; else ENTRY="$ENTRY_VIP"; NAME="VIP"; fi
[ "$CHECK_ONLY" != "1" ] && echo "[*] Starting $NAME..."

# ── environment ──────────────────────────────────────────────────────────────
# Everything the tool touches at boot: PATH, apt mirror, git/curl, node+openssl,
# sqlite3, termux-api (wake-lock), Termux:Boot, npm packages, tsu (root).

# switch to the official mirror when the current one is stale or returns 404
use_official_mirror() {
  echo "[*] Mirror is failing, switching to the official one (packages.termux.dev)..."
  rm -f "$PREFIX_DIR/etc/termux/chosen_mirrors" 2>/dev/null
  mkdir -p "$PREFIX_DIR/etc/apt" 2>/dev/null
  echo "deb https://packages.termux.dev/apt/termux-main stable main" > "$PREFIX_DIR/etc/apt/sources.list"
  rm -rf "$PREFIX_DIR/var/lib/apt/lists/"* 2>/dev/null
}

# pkg_install <name...>: normal install, then --fix-missing, then the official mirror
pkg_install() {
  pkg update >/dev/null 2>&1; pkg install "$@" && return 0
  echo "[!] Installing '$*' failed, retrying with --fix-missing..."
  apt-get update >/dev/null 2>&1; apt-get install -y --fix-missing "$@" && return 0
  use_official_mirror
  apt-get update >/dev/null 2>&1; apt-get install -y --fix-missing "$@" && return 0
  return 1
}

# apt_install <name...>: apt path only (no pkg wrapper, no yes-pipe), same mirror fallback
apt_install() {
  apt-get update >/dev/null 2>&1; apt-get install -y -o Dpkg::Options::=--force-confnew "$@" && return 0
  use_official_mirror
  apt-get update >/dev/null 2>&1; apt-get install -y -o Dpkg::Options::=--force-confnew "$@" && return 0
  return 1
}

# dpkg holds the package database lock; a killed loader / interrupted pkg leaves it
fix_dpkg_lock() {
  local l1="$PREFIX_DIR/var/lib/dpkg/lock-frontend" l2="$PREFIX_DIR/var/lib/dpkg/lock"
  local held=0
  command -v fuser >/dev/null 2>&1 && { fuser "$l1" "$l2" >/dev/null 2>&1 && held=1; }
  [ -f "$l1.lck" ] || [ -f "$l2.lck" ] && held=1
  [ "$held" = "1" ] || return 0
  echo "[!] Package manager lock is held, clearing it..."
  for f in "$l1" "$l2" "$l1.lck" "$l2.lck"; do rm -f "$f" 2>/dev/null; done
  dpkg --configure -a >/dev/null 2>&1
}
fix_dpkg_lock

# packages.* also needs to be writable by the loader when it runs as a normal user
ensure_prefix_writable() {
  [ -w "$PREFIX_DIR/bin" ] && return 0
  [ "$(id -u 2>/dev/null)" = "0" ] && return 0
  command -v su >/dev/null 2>&1 && su -c "chown -R $(id -u):$(id -g) $PREFIX_DIR" >/dev/null 2>&1
}
ensure_prefix_writable

# every Termux binary + Android system bins + a sane core PATH, so a call from
# Termux:Boot (which hands over a near-empty PATH) still finds date/sleep/node
export PATH="$TBIN:/data/data/com.termux/files/home/.local/bin:/system/bin:/system/xbin:/vendor/bin:${PATH:-/usr/bin:/bin}"
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-$PREFIX_DIR/lib}"
export HOME="${HOME:-/data/data/com.termux/files/home}"

# android arch / api: used to pick the right npm optional binaries
ARCH="$(getprop ro.product.cpu.abi 2>/dev/null)"
[ -z "${ARCH:-}" ] && ARCH="$(uname -m 2>/dev/null)"
API="$(getprop ro.build.version.sdk 2>/dev/null)"

# network probe that works without curl/wget (bash /dev/tcp)
net_ok() {
  (exec 3<>/dev/tcp/github.com/443) 2>/dev/null && { exec 3<&- 3>&-; return 0; }
  return 1
}

# run something as root without a TTY prompt (works under --autostart)
as_root() {
  local s
  for s in "$TBIN/su" /system/xbin/su /system/bin/su /sbin/su su; do
    command -v "$s" >/dev/null 2>&1 || [ -x "$s" ] || continue
    "$s" -c "$1" >/dev/null 2>&1 && return 0
  done
  return 1
}

have_root() { [ "$(id -u 2>/dev/null)" = "0" ]; }

# ── mirror / toolchain ───────────────────────────────────────────────────────
# keep the mirror it has if packages still resolve, only switch when they don't
if ! net_ok; then
  echo "[!] No network (github.com:443 unreachable). Going offline-safe."
  OFFLINE=1
else
  OFFLINE=0
fi

if [ "$OFFLINE" = "0" ]; then
  pkg update >/dev/null 2>&1
  if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    pkg_install git curl || echo "[!] git/curl install failed, will try the tarball path."
  fi
else
  command -v git >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 || USE_TAR=1
fi
USE_TAR="${USE_TAR:-0}"

# ── download / update source ─────────────────────────────────────────────────
download_tarball() {
  T="$(mktemp -d 2>/dev/null || echo "$HOME/.rejoin_dl")"; mkdir -p "$T"
  URL="$R/archive/refs/heads/main.tar.gz"
  if command -v curl >/dev/null; then curl -fL --retry 3 --connect-timeout 15 -o "$T/r.tgz" "$URL" || return 1
  elif command -v wget >/dev/null; then wget -O "$T/r.tgz" "$URL" || return 1
  else echo "[-] No git, curl or wget to download the source with."; return 1; fi
  mkdir -p "$D"
  # remove the old files but keep node_modules
  find "$D" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} + 2>/dev/null
  tar -xzf "$T/r.tgz" -C "$D" --strip-components=1 || return 1
  rm -rf "$T"
  return 0
}

if [ -n "${USE_TAR:-}" ] && [ "$USE_TAR" = "1" ]; then
  if [ "$AUTOSTART" = "1" ] && [ -d "$D" ]; then
    echo "[*] Autostart — skipping update."
  elif [ ! -d "$D" ]; then
    download_tarball || { echo "[-] Source download failed. Check your network and run again."; exit 1; }
  fi
elif [ "$AUTOSTART" = "1" ] && [ -d "$D" ]; then
  echo "[*] Autostart — skipping update."
elif [ ! -d "$D/.git" ]; then
  cd "$HOME" || cd / 2>/dev/null || true
  OLD="$D.old.$$"
  [ -d "$D" ] && { mv "$D" "$OLD" 2>/dev/null || rm -rf "$D"; }
  if git clone --depth 1 "$R" "$D" 2>/dev/null; then
    rm -rf "$OLD" 2>/dev/null
  else
    echo "[!] git clone failed, trying the tarball..."
    # a broken checkout is put back so the tarball can reuse the node_modules that are still valid
    [ -d "$OLD" ] && mv "$OLD" "$D" 2>/dev/null
    download_tarball || exit 1
  fi
else
  cd "$D" || exit 1
  # point the remote back at the right repo if it was changed
  CUR=$(git remote get-url origin 2>/dev/null)
  [ "$CUR" != "$R" ] && git remote set-url origin "$R"
  git fetch --all --prune || exit 1

  # save configs left inside the repo by old versions before reset / clean
  for f in $CFGS; do
    [ -f "$D/$f" ] && [ ! -f "$ROBLOX_REJOIN_HOME/$f" ] && cp -f "$D/$f" "$ROBLOX_REJOIN_HOME/$f" 2>/dev/null
  done

  EXCL="-e node_modules"
  for f in $CFGS; do EXCL="$EXCL -e $f"; done

  git reset --hard origin/main
  # shellcheck disable=SC2086
  git clean -fd $EXCL
fi

# self-update: if the repo has a newer loader.sh than the installed one, install it and re-run
if [ -z "${LOADER_REEXEC:-}" ] && [ -f "$D/loader.sh" ] && [ -f "$L" ] && ! cmp -s "$D/loader.sh" "$L"; then
  if cp "$D/loader.sh" "$L" 2>/dev/null && sed -i 's/\r$//' "$L" && chmod +x "$L"; then
    echo "[*] Loader updated from the repo, restarting..."
    LOADER_REEXEC=1 exec bash "$L" "$CHOICE" "$@"
  fi
fi

# ── packages ─────────────────────────────────────────────────────────────────
# nodejs-lts is the pinned line; plain `nodejs` also works and is used as fallback
ensure_node() {
  N="/data/data/com.termux/files/usr/bin/node"
  [ ! -x "$N" ] && N="$(command -v node 2>/dev/null)"
  if [ -z "${N:-}" ]; then
    pkg_install nodejs-lts || pkg_install nodejs
    N="$(command -v node 2>/dev/null)"
  fi
  [ -n "${N:-}" ] || return 1

  # node has to run: "cannot locate symbol OSSL_PROVIDER_..." = new node + old openssl
  node_ok() { "$N" -v >/dev/null 2>&1; }
  node_ok && return 0

  local attempt
  for attempt in 1 2; do
    echo "[!] node is broken (openssl mismatch), fixing packages (attempt $attempt)..."
    [ "$attempt" = "2" ] && use_official_mirror
    apt-get update >/dev/null 2>&1
    apt-get upgrade -y -o Dpkg::Options::=--force-confnew 2>&1 | tail -3
    apt-get install -y --reinstall openssl nodejs nodejs-lts >/dev/null 2>&1
    node_ok && { echo "[+] node works now: $("$N" -v)"; return 0; }
  done
  return 1
}

# a stale /usr/bin/node (from the `nodejs` shim of another tool) shadows the Termux one
dedupe_node_path() {
  local dup
  for dup in /usr/bin/node /usr/local/bin/node /bin/node; do
    [ -x "$dup" ] || continue
    if [ "$dup" != "$N" ] && [ "$(readlink -f "$dup" 2>/dev/null)" != "$(readlink -f "$N" 2>/dev/null)" ]; then
      [ -w "$dup" ] && rm -f "$dup" 2>/dev/null && echo "[*] Removed shadowing node at $dup"
    fi
  done
}

ensure_node || { echo "[-] Could not install a working nodejs. Run: pkg upgrade -y  (if that fails: termux-change-repo, then pkg upgrade -y)"; exit 1; }
dedupe_node_path

# install each required package only when its probe fails
pkg_present() {
  case "$1" in
    nodejs|nodejs-lts) command -v node >/dev/null 2>&1 ;;
    sqlite)            command -v sqlite3 >/dev/null 2>&1 ;;
    termux-api)        command -v termux-wake-lock >/dev/null 2>&1 ;;
    termux-boot)       [ -d /data/data/com.termux.boot ] ;;
    coreutils)         command -v true >/dev/null 2>&1 && command -v env >/dev/null 2>&1 ;;
    termux-tools)      command -v termux-setup-storage >/dev/null 2>&1 || [ -f "$PREFIX_DIR/bin/termux-wake-lock" ] ;;
    *)                 true ;;
  esac
}

if [ "$OFFLINE" = "0" ]; then
  for p in $PKG_REQ; do
    pkg_present "$p" && continue
    pkg_install "$p" >/dev/null 2>&1 || echo "[!] Could not install '$p': $(
      case "$p" in
        sqlite) echo "cookies won't be readable (pkg install sqlite)" ;;
        termux-api) echo "wake-lock off, long runs may be killed (pkg install termux-api)" ;;
        termux-boot) echo "no autostart on reboot — install Termux:Boot from F-Droid, open it once" ;;
        *) echo "install it manually: pkg install $p" ;;
      esac
    )"
  done
fi

# arm64 / 32-bit sanity: an x86 npm binary from a copied node_modules just crashes
if [ -d "$D/node_modules" ] && [ -n "${ARCH:-}" ]; then
  if [ -d "$D/node_modules/sqlite3" ] && ls "$D"/node_modules/sqlite3/lib/binding >/dev/null 2>&1; then
    case "$ARCH" in
      arm64*) [ -d "$D/node_modules/sqlite3/lib/binding/node-v"*"-linux-arm64" ] || rm -rf "$D/node_modules/sqlite3" 2>/dev/null ;;
    esac
  fi
fi

# root helper: tsu (Magisk), or a shim so `su -c` works from a boot context
if ! have_root; then
  if ! command -v su >/dev/null 2>&1; then
    pkg_install tsu >/dev/null 2>&1 || echo "[!] No su/tsu: root features unavailable (cookie read via /data, kill by package). Install: pkg install tsu and grant Magisk."
  fi
  # root needed for cookie read + force-stop; check once, warn once, never abort
  if ! as_root "id -u" >/dev/null 2>&1; then
    ROOT_STATE="$(cat "$SS" 2>/dev/null)"
    [ "$ROOT_STATE" != "noroot" ] && echo "[!] Cannot become root (su not granted). The tool runs degraded until root is granted to Termux + tsu; state saved, no spam."
    echo "noroot" > "$SS" 2>/dev/null
  elif [ "$(cat "$SS" 2>/dev/null)" = "noroot" ]; then
    rm -f "$SS" 2>/dev/null
  fi
fi

# npm dependencies (VIP only — LITE has none)
npm_bin() {
  local c
  for c in "$TBIN/npm" "$(command -v npm 2>/dev/null)" "$(dirname "$N")/npm"; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

if [ "$CHOICE" = "1" ] && [ "$OFFLINE" = "0" ]; then
  NB="$(npm_bin)"
  if [ -z "${NB:-}" ]; then
    pkg_install nodejs-lts >/dev/null 2>&1 || pkg_install nodejs >/dev/null 2>&1
    NB="$(npm_bin)"
  fi
  if [ -n "${NB:-}" ]; then
    cd "$D" || exit 1
    # one pass for all three, no per-package npm start-up cost
    NEED=""
    for m in $NPM_REQ; do
      [ -d "$D/node_modules/$m" ] || NEED="$NEED $m"
    done
    if [ -n "$NEED" ]; then
      echo "[*] Installing npm dependencies:$NEED"
      if ! "$NB" install --no-audit --no-fund $NEED >>"$ROBLOX_REJOIN_HOME/npm.log" 2>&1; then
        # group install failed — fall back one by one so one bad package doesn't block the rest
        for m in $NEED; do
          [ -d "$D/node_modules/$m" ] && continue
          "$NB" install --no-audit --no-fund "$m" >>"$ROBLOX_REJOIN_HOME/npm.log" 2>&1 \
            || echo "[!] npm install $m failed (see $ROBLOX_REJOIN_HOME/npm.log)"
        done
      fi
    fi
  fi
else
  cd "$D" 2>/dev/null || true
fi

# ── preflight ────────────────────────────────────────────────────────────────
cd "$D" 2>/dev/null || { echo "[-] Repo dir missing: $D"; exit 1; }

# make sure the entry file exists
[ ! -f "$W/$ENTRY" ] && { echo "[-] '$ENTRY' not found in $W"; exit 1; }

# node must actually parse the entry before we hand over to it
"$N" --check "$W/$ENTRY" >/dev/null 2>&1 || echo "[!] '$ENTRY' failed the syntax check — the repo may be mid-update, re-run the loader."

# config dir + files the tool writes on first run
mkdir -p "$ROBLOX_REJOIN_HOME/tmp" 2>/dev/null
chmod 700 "$ROBLOX_REJOIN_HOME/tmp" 2>/dev/null

# localStorage / cookie DB live under the app data dirs; a missing package means the game isn't installed
if [ "$CHECK_ONLY" = "1" ]; then
  echo
  echo "── environment ───────────────────────────────"
  printf '%-16s %s\n' "node"      "$("$N" -v 2>/dev/null || echo MISSING)"
  printf '%-16s %s\n' "npm"       "$(npm_bin || echo MISSING)"
  printf '%-16s %s\n' "sqlite3"   "$(command -v sqlite3 || echo MISSING)"
  printf '%-16s %s\n' "termux-api" "$(command -v termux-wake-lock || echo MISSING)"
  printf '%-16s %s\n' "termux-boot" "$([ -d /data/data/com.termux.boot ] && echo ok || echo MISSING-F-DROID)"
  printf '%-16s %s\n' "root"      "$(as_root 'id -u' 2>/dev/null && echo ok || echo no)"
  printf '%-16s %s\n' "arch"      "${ARCH:-unknown}"
  printf '%-16s %s\n' "api"       "${API:-unknown}"
  printf '%-16s %s\n' "repo"      "$([ -d "$D/.git" ] && echo git || echo tarball)"
  printf '%-16s %s\n' "config"    "$ROBLOX_REJOIN_HOME"
  printf '%-16s %s\n' "boot script" "$(ls "$HOME"/.termux/boot/rejoin*_autostart.sh 2>/dev/null | tr '\n' ' ')"
  if [ "$CHOICE" = "1" ]; then
    for m in $NPM_REQ; do
      printf '%-16s %s\n' "npm:$m" "$([ -d "$D/node_modules/$m" ] && echo ok || echo MISSING)"
    done
  fi
  echo "──────────────────────────────────────────────"
  exit 0
fi

# ── run ──────────────────────────────────────────────────────────────────────
cd "$W" || exit 1
if [ "$AUTOSTART" = "1" ]; then
  exec "$N" "$ENTRY" --autostart "$@"
else
  exec "$N" "$ENTRY" "$@"
fi
