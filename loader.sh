#!/bin/bash
set -u

pkg(){ yes | command pkg "$@"; }

R="https://github.com/QT305/roblox-rejoin"
D="$HOME/roblox-rejoin"
W="$D"
ENTRY_VIP="rejoin.cjs"
ENTRY_LITE="rejoin lite.cjs"
PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"
L="$PREFIX_DIR/bin/loader"

ROBLOX_REJOIN_HOME="${ROBLOX_REJOIN_HOME:-$HOME/.roblox-rejoin}"
export ROBLOX_REJOIN_HOME
mkdir -p "$ROBLOX_REJOIN_HOME"

CFGS="multi_configs.json webhook_config.json package_prefix_config.json activity_config.json autoexec_config.json launch_activity_cache.json"
LAST_FILE="$ROBLOX_REJOIN_HOME/loader_choice"

SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
if [ "$SELF" != "$L" ] && { [ ! -f "$L" ] || ! cmp -s "$SELF" "$L"; }; then
  cp "$SELF" "$L" 2>/dev/null && sed -i 's/\r$//' "$L" && chmod +x "$L"
fi

LAST="$(cat "$LAST_FILE" 2>/dev/null)"
case "$LAST" in 1|2) ;; *) LAST=1 ;; esac

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
if [ "$AUTOSTART" = "1" ]; then
  CHOICE="$LAST"
else
  if [ $# -gt 0 ]; then
    CHOICE="$(normalize "$1")"
    [ -n "$CHOICE" ] && shift
  fi
  [ -z "$CHOICE" ] && CHOICE="$(normalize "${LOADER_CHOICE:-}")"
fi

if [ -z "$CHOICE" ]; then
  C1=$'\033[1;38;5;87m'; C2=$'\033[1;38;5;121m'; C3=$'\033[38;5;245m'; C4=$'\033[38;5;63m'; C0=$'\033[0m'
  [ -t 1 ] || { C1=""; C2=""; C3=""; C4=""; C0=""; }
  echo
  echo "${C4}╭─ ${C1}ROBLOX REJOIN${C4} ────────────────────────────────────╮${C0}"
  echo "${C4}│${C0}                                                    ${C4}│${C0}"
  echo "${C4}│${C0}  ${C2}[1]${C0} VIP   ${C3}all features (rejoin.cjs)${C0}               ${C4}│${C0}"
  echo "${C4}│${C0}  ${C2}[2]${C0} LITE  ${C3}light, smooth on long runs${C0}              ${C4}│${C0}"
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

use_official_mirror() {
  echo "[*] Mirror is failing, switching to the official one (packages.termux.dev)..."
  rm -f "$PREFIX_DIR/etc/termux/chosen_mirrors" 2>/dev/null
  mkdir -p "$PREFIX_DIR/etc/apt" 2>/dev/null
  echo "deb https://packages.termux.dev/apt/termux-main stable main" > "$PREFIX_DIR/etc/apt/sources.list"
  rm -rf "$PREFIX_DIR/var/lib/apt/lists/"* 2>/dev/null
}

UPDATED=0
pkg_install() {
  if [ "$UPDATED" = "0" ]; then pkg update >/dev/null 2>&1; UPDATED=1; fi
  pkg install "$@" && return 0
  echo "[!] Installing '$*' failed, retrying with --fix-missing..."
  apt-get update >/dev/null 2>&1; apt-get install -y --fix-missing "$@" && return 0
  use_official_mirror
  apt-get update >/dev/null 2>&1; apt-get install -y --fix-missing "$@" && return 0
  return 1
}

N="$PREFIX_DIR/bin/node"
[ ! -x "$N" ] && N="$(command -v node 2>/dev/null)"

echo "[*] Checking required packages..."
USE_TAR=0
command -v curl >/dev/null 2>&1 || pkg_install curl || echo "[!] Could not install curl."
command -v git >/dev/null 2>&1 || pkg_install git || { echo "[!] Could not install git, downloading the source directly."; USE_TAR=1; }
if [ -z "${N:-}" ]; then
  pkg_install nodejs
  N="$(command -v node 2>/dev/null)"
fi
[ -z "${N:-}" ] && { echo "[-] Could not install nodejs."; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || pkg_install sqlite || echo "[!] Could not install sqlite3, the tool will fail when reading cookies."
command -v termux-wake-lock >/dev/null 2>&1 || pkg_install termux-api 2>/dev/null || echo "[!] Could not install termux-api (wake-lock won't work)."
[ -d "/data/data/com.termux.boot" ] || pkg_install termux-boot 2>/dev/null || echo "[!] Could not install termux-boot (autostart on reboot won't work)."

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
  node_ok || { echo "[-] node still fails. Run: pkg upgrade -y (if that doesn't help: termux-change-repo, then pkg upgrade -y)"; exit 1; }
  echo "[+] node works now: $("$N" -v)"
fi

download_tarball() {
  T="$(mktemp -d 2>/dev/null || echo "$HOME/.rejoin_dl")"; mkdir -p "$T"
  URL="$R/archive/refs/heads/main.tar.gz"
  if command -v curl >/dev/null; then curl -fL --retry 3 -o "$T/r.tgz" "$URL" || return 1
  elif command -v wget >/dev/null; then wget -O "$T/r.tgz" "$URL" || return 1
  else echo "[-] No git, curl or wget to download the source with."; return 1; fi
  mkdir -p "$D"
  find "$D" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} + 2>/dev/null
  tar -xzf "$T/r.tgz" -C "$D" --strip-components=1 || return 1
  rm -rf "$T"
  return 0
}

if [ "$AUTOSTART" = "1" ] && [ -d "$D" ]; then
  echo "[*] Autostart - skipping update."
elif [ "$USE_TAR" = "1" ]; then
  download_tarball || { echo "[-] Source download failed. Check your network and run again."; exit 1; }
elif [ ! -d "$D/.git" ]; then
  rm -rf "$D"
  git clone "$R" "$D" || { echo "[!] git clone failed, trying the tarball..."; download_tarball || exit 1; }
else
  cd "$D" || exit 1
  CUR=$(git remote get-url origin 2>/dev/null)
  [ "$CUR" != "$R" ] && git remote set-url origin "$R"
  git fetch --all --prune || exit 1
  for f in $CFGS; do
    [ -f "$D/$f" ] && [ ! -f "$ROBLOX_REJOIN_HOME/$f" ] && cp -f "$D/$f" "$ROBLOX_REJOIN_HOME/$f" 2>/dev/null
  done
  EXCL="-e node_modules"
  for f in $CFGS; do EXCL="$EXCL -e $f"; done
  git reset --hard origin/main
  git clean -fd $EXCL
fi

if [ -z "${LOADER_REEXEC:-}" ] && [ -f "$D/loader.sh" ] && [ -f "$L" ] && ! cmp -s "$D/loader.sh" "$L"; then
  if cp "$D/loader.sh" "$L" 2>/dev/null && sed -i 's/\r$//' "$L" && chmod +x "$L"; then
    echo "[*] Loader updated from the repo, restarting..."
    LOADER_REEXEC=1 exec bash "$L" "$CHOICE" "$@"
  fi
fi

S="$(command -v su 2>/dev/null)"
[ -n "${S:-}" ] && {
  grep -qxF "alias node='$N'" ~/.bashrc 2>/dev/null || echo "alias node='$N'" >> ~/.bashrc
  grep -qxF "export PATH=\"$(dirname "$N"):\$PATH\"" ~/.bashrc 2>/dev/null || echo "export PATH=\"$(dirname "$N"):\$PATH\"" >> ~/.bashrc
  source ~/.bashrc 2>/dev/null || true
}

cd "$D" || exit 1
if [ "$CHOICE" = "1" ]; then
  [ ! -d "$D/node_modules" ] && { npm install --no-audit --no-fund || exit 1; }
fi

[ ! -f "$W/$ENTRY" ] && { echo "[-] '$ENTRY' not found in $W"; exit 1; }
cd "$W" || exit 1

if [ "$AUTOSTART" = "1" ]; then
  exec "$N" "$ENTRY" --autostart "$@"
else
  exec "$N" "$ENTRY" "$@"
fi
