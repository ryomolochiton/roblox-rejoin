#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "🚀 Roblox Rejoin Loader"

dpkg --configure -a || true
apt --fix-broken install -y || true

pkg update -y
pkg install -y nodejs npm sqlite git

TOOL_DIR="$HOME/roblox-rejoin"
REPO_URL="https://github.com/buithanhquang052008-cloud/roblox-rejoin.git"

if [ ! -d "$TOOL_DIR/.git" ]; then
  git clone "$REPO_URL" "$TOOL_DIR"
else
  cd "$TOOL_DIR"
  git reset --hard
  git pull
fi

cd "$TOOL_DIR"

npm install --no-audit --no-fund

chmod +x rejoin.cjs

echo "✅ Chạy tool"
node rejoin.cjs
