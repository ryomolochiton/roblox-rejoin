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

# git
command -v git >/dev/null || { pkg update; pkg install git || exit 1; }

# clone / update
if [ ! -d "$D/.git" ]; then
  rm -rf "$D"
  git clone "$R" "$D" || exit 1
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

# node
N="/data/data/com.termux/files/usr/bin/node"
[ ! -x "$N" ] && { pkg install which >/dev/null 2>&1; N=$(which node); }
[ -z "${N:-}" ] && { pkg update; pkg upgrade; pkg install nodejs; N=$(which node) || exit 1; }

# sqlite3 (ca 2 ban deu can)
command -v sqlite3 >/dev/null || pkg install sqlite >/dev/null 2>&1 || true

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
