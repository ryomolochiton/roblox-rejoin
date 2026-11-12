#!/bin/bash
# loader.sh - downloads / updates the repo and runs the VIP or LITE version
# usage: loader          -> menu (1 = VIP, 2 = LITE)
#        loader 1|vip    -> run VIP directly
#        loader 2|lite   -> run LITE directly
set -u

pkg(){ yes | command pkg "$@"; }

R="https://github.com/ryomolochiton/roblox-rejoin"
D="$HOME/roblox-rejoin"
W="$D"
ENTRY_VIP="rejoin.cjs"
ENTRY_LITE="rejoin lite.cjs"   # the file name has a space
L="/data/data/com.termux/files/usr/bin/loader"

# config lives outside the repo so git reset / clean can't wipe it
ROBLOX_REJOIN_HOME="${ROBLOX_REJOIN_HOME:-$HOME/.roblox-rejoin}"
export ROBLOX_REJOIN_HOME
mkdir -p "$ROBLOX_REJOIN_HOME"

CFGS="multi_configs.json webhook_config.json package_prefix_config.json activity_config.json autoexec_config.json launch_activity_cache.json"
LAST_FILE="$ROBLOX_REJOIN_HOME/loader_choice"

# npm packages rejoin.cjs requires (same list as ensurePackages() in rejoin.cjs); LITE has none
VIP_DEPS="axios cli-table3 figlet"

# configs left inside the repo dir by old versions -> copy them to $ROBLOX_REJOIN_HOME
# (copies only the missing ones; must run before ANY path that wipes $D: git reset/clean, tarball, re-clone)
save_old_configs() {
  for f in $CFGS; do
    [ -f "$D/$f" ] && [ ! -f "$ROBLOX_REJOIN_HOME/$f" ] && cp -f "$D/$f" "$ROBLOX_REJOIN_HOME/$f" 2>/dev/null
  done
  return 0
}

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
_rebuild=()
for _a in "$@"; do
  [ "$_a" = "--autostart" ] && { AUTOSTART=1; continue; }
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
  # first argument: vip / lite / 1 / 2
  if [ $# -gt 0 ]; then
    CHOICE="$(normalize "$1")"
    [ -n "$CHOICE" ] && shift
  fi
  # or the environment variable
  [ -z "$CHOICE" ] && CHOICE="$(normalize "${LOADER_CHOICE:-}")"
fi

# otherwise show the menu
if [ -z "$CHOICE" ]; then
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
  { read -r ANS </dev/tty; } 2>/dev/null || read -r ANS || ANS=""
  if [ -z "$ANS" ]; then
    CHOICE="$LAST"
  else
    CHOICE="$(normalize "$ANS")"
    [ -z "$CHOICE" ] && { echo "[-] Invalid choice."; exit 1; }
  fi
fi

echo "$CHOICE" > "$LAST_FILE" 2>/dev/null
if [ "$CHOICE" = "2" ]; then ENTRY="$ENTRY_LITE"; NAME="LITE"; else ENTRY="$ENTRY_VIP"; NAME="VIP"; fi
echo "[*] Starting $NAME..."

# package install with fallbacks for mirror errors (404 / Failed to fetch)
PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"

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

# download the source as a tarball (no git needed)
download_tarball() {
  T="$(mktemp -d 2>/dev/null || echo "$HOME/.rejoin_dl")"; mkdir -p "$T"
  URL="$R/archive/refs/heads/main.tar.gz"
  if command -v curl >/dev/null; then curl -fL --retry 3 -o "$T/r.tgz" "$URL" || return 1
  elif command -v wget >/dev/null; then wget -O "$T/r.tgz" "$URL" || return 1
  else echo "[-] No git, curl or wget to download the source with."; return 1; fi
  mkdir -p "$D"
  # remove the old files but keep node_modules
  find "$D" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} + 2>/dev/null
  tar -xzf "$T/r.tgz" -C "$D" --strip-components=1 || return 1
  rm -rf "$T"
  return 0
}

# git, or the tarball if git can't be installed
USE_TAR=0
if ! command -v git >/dev/null; then
  pkg_install git || { echo "[!] Could not install git, downloading the source directly."; USE_TAR=1; }
fi

[ -d "$D" ] && save_old_configs

# skip git update in autostart mode: network may be unavailable at boot and
# the tool is already up-to-date from the last manual run.
# if the repo dir is missing entirely, still clone/download so the tool can run.
if [ "$AUTOSTART" = "1" ] && [ -d "$D" ]; then
  echo "[*] Autostart — skipping update."
elif [ "$USE_TAR" = "1" ]; then
  download_tarball || { echo "[-] Source download failed. Check your network and run again."; exit 1; }
elif [ ! -d "$D/.git" ]; then
  rm -rf "$D"
  git clone "$R" "$D" || { echo "[!] git clone failed, trying the tarball..."; download_tarball || exit 1; }
else
  cd "$D" || exit 1
  # point the remote back at the right repo if it was changed
  CUR=$(git remote get-url origin 2>/dev/null)
  [ "$CUR" != "$R" ] && git remote set-url origin "$R"
  git fetch --all --prune || exit 1

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
    # --autostart was stripped from "$@" above; the cjs only resumes when it sees it, so pass it on again
    # (the choice is already saved in $LAST_FILE, so autostart doesn't need it as an argument)
    if [ "$AUTOSTART" = "1" ]; then
      LOADER_REEXEC=1 exec bash "$L" --autostart "$@"
    else
      LOADER_REEXEC=1 exec bash "$L" "$CHOICE" "$@"
    fi
  fi
fi

# node
N="/data/data/com.termux/files/usr/bin/node"
[ ! -x "$N" ] && N="$(command -v node 2>/dev/null)"
[ -z "${N:-}" ] && { pkg_install nodejs; N="$(command -v node 2>/dev/null)"; }
[ -z "${N:-}" ] && { echo "[-] Could not install nodejs."; exit 1; }

# node has to run: "cannot locate symbol OSSL_PROVIDER_..." means a new node with an old openssl (upgrading fixes it)
node_ok() { "$N" -v >/dev/null 2>&1; }
if ! node_ok; then
  echo "[!] node is broken (old openssl), updating Termux packages..."
  pkg update >/dev/null 2>&1
  pkg upgrade -y -o Dpkg::Options::=--force-confnew 2>&1 | tail -3
  node_ok || { echo "[!] Reinstalling openssl + nodejs..."; apt-get install -y --reinstall openssl nodejs >/dev/null 2>&1; }
  if ! node_ok; then
    use_official_mirror
    apt-get update >/dev/null 2>&1
    apt-get upgrade -y -o Dpkg::Options::=--force-confnew 2>&1 | tail -3
    apt-get install -y --reinstall openssl nodejs >/dev/null 2>&1
  fi
  node_ok || { echo "[-] node still fails. Run: pkg upgrade -y  (if that doesn't help: termux-change-repo, then pkg upgrade -y)"; exit 1; }
  echo "[+] node works now: $("$N" -v)"
fi

# sqlite3 (both versions need it)
command -v sqlite3 >/dev/null || pkg_install sqlite || echo "[!] Could not install sqlite3, the tool will fail when reading cookies."

# termux-api: provides termux-wake-lock / termux-wake-unlock, which both rejoin.cjs and the boot script call
# missing is non-fatal (tool still runs, just no wake-lock)
# Termux:Boot is a separate APK, not a pkg: rejoin.cjs writes ~/.termux/boot/roblox-rejoin.sh itself and
# shows a hint if the app is missing, so there is nothing to install here
command -v termux-wake-lock >/dev/null 2>&1 || pkg_install termux-api 2>/dev/null || echo "[!] Could not install termux-api (wake-lock won't work)."

# alias for running under su / root (added once so ~/.bashrc doesn't grow on every run)
S=$(which su 2>/dev/null)
[ -n "${S:-}" ] && {
  grep -qxF "alias node='$N'" ~/.bashrc 2>/dev/null || echo "alias node='$N'" >> ~/.bashrc
  grep -qxF "export PATH=\"$(dirname "$N"):\$PATH\"" ~/.bashrc 2>/dev/null || echo "export PATH=\"$(dirname "$N"):\$PATH\"" >> ~/.bashrc
  # no `source ~/.bashrc` here: rejoin.cjs puts its autostart hook in that file, and sourcing it from the
  # loader could start a second `loader --autostart` inside this run
}

# dependencies: only VIP needs node_modules (LITE has none)
# rejoin.cjs checks axios / cli-table3 / figlet itself and installs what is missing, so a failed npm
# install here is not fatal (e.g. no network at boot), and the old package.json may list dead packages
cd "$D" || exit 1
if [ "$CHOICE" = "1" ]; then
  MISSING=""
  for m in $VIP_DEPS; do [ -d "$D/node_modules/$m" ] || MISSING="$MISSING $m"; done
  if [ -n "$MISSING" ]; then
    echo "[*] Installing npm packages:$MISSING"
    # shellcheck disable=SC2086
    npm install --no-audit --no-fund $MISSING || echo "[!] npm install failed, rejoin.cjs will try again on start."
  fi
fi

# make sure the entry file exists
[ ! -f "$W/$ENTRY" ] && { echo "[-] '$ENTRY' not found in $W"; exit 1; }

cd "$W" || exit 1
if [ "$AUTOSTART" = "1" ]; then
  exec "$N" "$ENTRY" --autostart "$@"
else
  exec "$N" "$ENTRY" "$@"
fi
