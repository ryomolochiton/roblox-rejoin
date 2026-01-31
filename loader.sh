#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "🚀 Roblox Rejoin Loader (ANDROID NODE / NO apt)"

REPO_URL="https://github.com/buithanhquang052008-cloud/roblox-rejoin"
REPO_DIR="$HOME/roblox-rejoin"

### ===== ARCH =====
ARCH=$(uname -m)
if [[ "$ARCH" == "aarch64" ]]; then
  NODE_ARCH="arm64"
elif [[ "$ARCH" == "armv7l" ]]; then
  NODE_ARCH="armv7"
else
  echo "❌ CPU không hỗ trợ: $ARCH"
  exit 1
fi

### ===== NODE ANDROID =====
NODE_DIR="$HOME/.node"
NODE_BIN="$NODE_DIR/bin/node"
NPM_BIN="$NODE_DIR/bin/npm"

NODE_VERSION="18.19.1"
NODE_URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v$NODE_VERSION/node-v$NODE_VERSION-android-$NODE_ARCH.tar.gz"

if [ ! -x "$NODE_BIN" ]; then
  echo "📦 Tải Node.js ANDROID ($NODE_ARCH)"
  mkdir -p "$NODE_DIR"
  cd "$NODE_DIR"

  curl -L "$NODE_URL" -o node.tar.gz
  tar -xzf node.tar.gz
  mv node-v$NODE_VERSION-android-$NODE_ARCH/* "$NODE_DIR/"
  rm -rf node-v$NODE_VERSION-android-$NODE_ARCH node.tar.gz

  chmod +x "$NODE_BIN" "$NPM_BIN"
fi

export PATH="$NODE_DIR/bin:$PATH"

### ===== CLONE / UPDATE =====
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "📥 Clone repo"
  git clone "$REPO_URL" "$REPO_DIR"
else
  echo "🔄 Update repo"
  cd "$REPO_DIR"
  git reset --hard
  git pull
fi

### ===== NPM INSTALL =====
cd "$REPO_DIR"
if [ ! -d node_modules ]; then
  echo "📦 npm install"
  "$NPM_BIN" install
fi

### ===== RUN TOOL =====
echo "🎮 Chạy Rejoin Tool"
exec "$NODE_BIN" rejoin.cjs
