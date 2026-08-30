#!/bin/bash
# loader.sh - tai/cap nhat repo va chay rejoin.cjs
set -u

pkg(){ yes | command pkg "$@"; }

R="https://github.com/ryomolochiton/roblox-rejoin"
D="$HOME/roblox-rejoin"
W="$D"
ENTRY="rejoin.cjs"
L="/data/data/com.termux/files/usr/bin/loader"

# Thu muc config nam NGOAI repo -> khong bi git reset/clean xoa mat
ROBLOX_REJOIN_HOME="${ROBLOX_REJOIN_HOME:-$HOME/.roblox-rejoin}"
export ROBLOX_REJOIN_HOME
mkdir -p "$ROBLOX_REJOIN_HOME"

CFGS="multi_configs.json webhook_config.json package_prefix_config.json activity_config.json autoexec_config.json launch_activity_cache.json"

# tu cai chinh no thanh lenh `loader`
[ ! -f "$L" ] && cp "$0" "$L" && sed -i 's/\r$//' "$L" && chmod +x "$L"

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

# sqlite3 (rejoin.cjs can)
command -v sqlite3 >/dev/null || pkg install sqlite >/dev/null 2>&1 || true

# alias khi chay bang su/root
S=$(which su 2>/dev/null)
[ -n "${S:-}" ] && {
  echo "alias node='$N'" >> ~/.bashrc
  echo "export PATH=\"$(dirname "$N"):\$PATH\"" >> ~/.bashrc
  source ~/.bashrc 2>/dev/null || true
}

# dependencies
cd "$D" || exit 1
[ ! -d "$D/node_modules" ] && { npm install --no-audit --no-fund || exit 1; }

# kiem tra entry
[ ! -f "$W/$ENTRY" ] && { echo "[-] Khong tim thay $ENTRY trong $W"; exit 1; }

cd "$W" || exit 1
exec "$N" "$ENTRY" "$@"
