#!/bin/bash
# loader.sh - tai/cap nhat repo va chay ban VIP hoac LITE
# Dung:  loader          -> hien khung chon (1 = VIP, 2 = LITE)
#        loader 1|vip    -> chay thang ban VIP
#        loader 2|lite   -> chay thang ban LITE
set -u

pkg(){ yes | command pkg "$@"; }

R="https://github.com/ryomolochiton/roblox-rejoin"
D="$HOME/roblox-rejoin"
W="$D"
ENTRY_VIP="rejoin.cjs"
ENTRY_LITE="rejoin lite.cjs"   # ten file co dau cach
L="/data/data/com.termux/files/usr/bin/loader"

# Thu muc config nam NGOAI repo -> khong bi git reset/clean xoa mat
ROBLOX_REJOIN_HOME="${ROBLOX_REJOIN_HOME:-$HOME/.roblox-rejoin}"
export ROBLOX_REJOIN_HOME
mkdir -p "$ROBLOX_REJOIN_HOME"

CFGS="multi_configs.json webhook_config.json package_prefix_config.json activity_config.json autoexec_config.json launch_activity_cache.json"
LAST_FILE="$ROBLOX_REJOIN_HOME/loader_choice"

# tu cai / cap nhat chinh no thanh lenh `loader` (cap nhat khi noi dung khac)
SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
if [ "$SELF" != "$L" ] && { [ ! -f "$L" ] || ! cmp -s "$SELF" "$L"; }; then
  cp "$SELF" "$L" 2>/dev/null && sed -i 's/\r$//' "$L" && chmod +x "$L"
fi

# ---------- khung chon ban ----------
LAST="$(cat "$LAST_FILE" 2>/dev/null)"
case "$LAST" in 1|2) ;; *) LAST=1 ;; esac

normalize() {
  case "$(echo "${1:-}" | tr 'A-Z' 'a-z')" in
    1|vip) echo 1 ;;
    2|lite) echo 2 ;;
    *) echo "" ;;
  esac
}

CHOICE=""
# 1) doi so dau tien: loader vip / loader lite / loader 1 / loader 2
if [ $# -gt 0 ]; then
  CHOICE="$(normalize "$1")"
  [ -n "$CHOICE" ] && shift
fi
# 2) bien moi truong
[ -z "$CHOICE" ] && CHOICE="$(normalize "${LOADER_CHOICE:-}")"

# 3) hien menu
if [ -z "$CHOICE" ]; then
  C1=$'\033[1;38;5;87m'; C2=$'\033[1;38;5;121m'; C3=$'\033[38;5;245m'; C4=$'\033[38;5;63m'; C0=$'\033[0m'
  [ -t 1 ] || { C1=""; C2=""; C3=""; C4=""; C0=""; }
  echo
  echo "${C4}╭─ ${C1}ROBLOX REJOIN${C4} ────────────────────────────────────╮${C0}"
  echo "${C4}│${C0}                                                    ${C4}│${C0}"
  echo "${C4}│${C0}  ${C2}[1]${C0} Ban VIP    ${C3}day du tinh nang (rejoin.cjs)${C0}      ${C4}│${C0}"
  echo "${C4}│${C0}  ${C2}[2]${C0} Ban LITE   ${C3}nhe, chay lau it lag${C0}               ${C4}│${C0}"
  echo "${C4}│${C0}                                                    ${C4}│${C0}"
  echo "${C4}╰────────────────────────────────────────────────────╯${C0}"
  printf "  Chon [1-2, Enter = %s]: " "$LAST"
  ANS=""
  { read -r ANS </dev/tty; } 2>/dev/null || read -r ANS || ANS=""
  if [ -z "$ANS" ]; then
    CHOICE="$LAST"
  else
    CHOICE="$(normalize "$ANS")"
    [ -z "$CHOICE" ] && { echo "[-] Lua chon khong hop le."; exit 1; }
  fi
fi

echo "$CHOICE" > "$LAST_FILE" 2>/dev/null
if [ "$CHOICE" = "2" ]; then ENTRY="$ENTRY_LITE"; NAME="LITE"; else ENTRY="$ENTRY_VIP"; NAME="VIP"; fi
echo "[*] Dang chay ban $NAME..."

# ---------- cai package co tu sua loi mirror (404 / Failed to fetch) ----------
PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"

# doi sang mirror chinh thuc khi mirror dang dung bi loi thoi / 404
use_official_mirror() {
  echo "[*] Mirror loi, doi sang mirror chinh thuc packages.termux.dev..."
  rm -f "$PREFIX_DIR/etc/termux/chosen_mirrors" 2>/dev/null
  mkdir -p "$PREFIX_DIR/etc/apt" 2>/dev/null
  echo "deb https://packages.termux.dev/apt/termux-main stable main" > "$PREFIX_DIR/etc/apt/sources.list"
  rm -rf "$PREFIX_DIR/var/lib/apt/lists/"* 2>/dev/null
}

# pkg_install <ten...>: thu lan luot cach thong thuong -> fix-missing -> doi mirror
pkg_install() {
  pkg update >/dev/null 2>&1; pkg install "$@" && return 0
  echo "[!] Cai '$*' loi, thu lai voi --fix-missing..."
  apt-get update >/dev/null 2>&1; apt-get install -y --fix-missing "$@" && return 0
  use_official_mirror
  apt-get update >/dev/null 2>&1; apt-get install -y --fix-missing "$@" && return 0
  return 1
}

# tai ma nguon bang tarball (khong can git)
download_tarball() {
  T="$(mktemp -d 2>/dev/null || echo "$HOME/.rejoin_dl")"; mkdir -p "$T"
  URL="$R/archive/refs/heads/main.tar.gz"
  if command -v curl >/dev/null; then curl -fL --retry 3 -o "$T/r.tgz" "$URL" || return 1
  elif command -v wget >/dev/null; then wget -O "$T/r.tgz" "$URL" || return 1
  else echo "[-] Khong co git / curl / wget de tai ma nguon."; return 1; fi
  mkdir -p "$D"
  # xoa file cu nhung giu node_modules
  find "$D" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} + 2>/dev/null
  tar -xzf "$T/r.tgz" -C "$D" --strip-components=1 || return 1
  rm -rf "$T"
  return 0
}

# git (neu khong cai duoc thi tu dong chuyen sang tai tarball)
USE_TAR=0
if ! command -v git >/dev/null; then
  pkg_install git || { echo "[!] Khong cai duoc git, chuyen sang tai ma nguon truc tiep."; USE_TAR=1; }
fi

# clone / update
if [ "$USE_TAR" = "1" ]; then
  download_tarball || { echo "[-] Tai ma nguon that bai. Kiem tra mang roi chay lai."; exit 1; }
elif [ ! -d "$D/.git" ]; then
  rm -rf "$D"
  git clone "$R" "$D" || { echo "[!] git clone loi, thu tai tarball..."; download_tarball || exit 1; }
else
  cd "$D" || exit 1
  # neu remote cu tro sai repo thi sua lai
  CUR=$(git remote get-url origin 2>/dev/null)
  [ "$CUR" != "$R" ] && git remote set-url origin "$R"
  git fetch --all --prune || exit 1

  # backup config con sot lai trong repo (ban cu) truoc khi reset/clean
  for f in $CFGS; do
    [ -f "$D/$f" ] && [ ! -f "$ROBLOX_REJOIN_HOME/$f" ] && cp -f "$D/$f" "$ROBLOX_REJOIN_HOME/$f" 2>/dev/null
  done

  EXCL="-e node_modules"
  for f in $CFGS; do EXCL="$EXCL -e $f"; done

  git reset --hard origin/main
  # shellcheck disable=SC2086
  git clean -fd $EXCL
fi

# tu cap nhat loader tu repo (neu repo co loader.sh moi hon ban dang cai) roi chay lai
if [ -z "${LOADER_REEXEC:-}" ] && [ -f "$D/loader.sh" ] && [ -f "$L" ] && ! cmp -s "$D/loader.sh" "$L"; then
  if cp "$D/loader.sh" "$L" 2>/dev/null && sed -i 's/\r$//' "$L" && chmod +x "$L"; then
    echo "[*] Da cap nhat loader tu repo, dang chay lai..."
    LOADER_REEXEC=1 exec bash "$L" "$CHOICE" "$@"
  fi
fi

# node
N="/data/data/com.termux/files/usr/bin/node"
[ ! -x "$N" ] && N="$(command -v node 2>/dev/null)"
[ -z "${N:-}" ] && { pkg_install nodejs; N="$(command -v node 2>/dev/null)"; }
[ -z "${N:-}" ] && { echo "[-] Khong cai duoc nodejs."; exit 1; }

# node phai chay duoc: loi "cannot locate symbol OSSL_PROVIDER_..." = node moi nhung openssl cu (cap nhat do dang)
node_ok() { "$N" -v >/dev/null 2>&1; }
if ! node_ok; then
  echo "[!] node bi loi thu vien (openssl cu). Dang cap nhat package Termux..."
  pkg update >/dev/null 2>&1
  pkg upgrade -y -o Dpkg::Options::=--force-confnew 2>&1 | tail -3
  node_ok || { echo "[!] Cai lai openssl + nodejs..."; apt-get install -y --reinstall openssl nodejs >/dev/null 2>&1; }
  if ! node_ok; then
    use_official_mirror
    apt-get update >/dev/null 2>&1
    apt-get upgrade -y -o Dpkg::Options::=--force-confnew 2>&1 | tail -3
    apt-get install -y --reinstall openssl nodejs >/dev/null 2>&1
  fi
  node_ok || { echo "[-] node van loi. Hay chay: pkg upgrade -y  (neu van loi: termux-change-repo roi pkg upgrade -y)"; exit 1; }
  echo "[+] node da chay duoc: $("$N" -v)"
fi

# sqlite3 (ca 2 ban deu can)
command -v sqlite3 >/dev/null || pkg_install sqlite || echo "[!] Chua cai duoc sqlite3 — tool se bao loi khi doc cookie."

# alias khi chay bang su/root (chi them 1 lan, tranh phinh ~/.bashrc moi lan chay)
S=$(which su 2>/dev/null)
[ -n "${S:-}" ] && {
  grep -qxF "alias node='$N'" ~/.bashrc 2>/dev/null || echo "alias node='$N'" >> ~/.bashrc
  grep -qxF "export PATH=\"$(dirname "$N"):\$PATH\"" ~/.bashrc 2>/dev/null || echo "export PATH=\"$(dirname "$N"):\$PATH\"" >> ~/.bashrc
  source ~/.bashrc 2>/dev/null || true
}

# dependencies: chi ban VIP can node_modules (ban LITE khong phu thuoc package nao)
cd "$D" || exit 1
if [ "$CHOICE" = "1" ]; then
  [ ! -d "$D/node_modules" ] && { npm install --no-audit --no-fund || exit 1; }
fi

# kiem tra entry
[ ! -f "$W/$ENTRY" ] && { echo "[-] Khong tim thay '$ENTRY' trong $W"; exit 1; }

cd "$W" || exit 1
exec "$N" "$ENTRY" "$@"
