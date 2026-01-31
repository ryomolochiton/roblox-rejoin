#!/usr/bin/env bash
set -e

echo "== Roblox Rejoin Loader (NO APT) =="

BASE="$HOME/roblox-rejoin"
NODE_DIR="$HOME/.node"
NODE_BIN="$NODE_DIR/bin/node"

# ===============================
# 1. Detect arch
# ===============================
ARCH=$(uname -m)
case "$ARCH" in
  aarch64) NODE_ARCH="linux-arm64" ;;
  armv7l)  NODE_ARCH="linux-armv7l" ;;
  x86_64)  NODE_ARCH="linux-x64" ;;
  *)
    echo "❌ Unsupported arch: $ARCH"
    exit 1
    ;;
esac

# ===============================
# 2. Install Node (if missing)
# ===============================
if [ ! -x "$NODE_BIN" ]; then
  echo "⬇️  Installing Node.js ($NODE_ARCH)"
  mkdir -p "$NODE_DIR"
  cd "$NODE_DIR"

  curl -L "https://nodejs.org/dist/v18.20.4/node-v18.20.4-$NODE_ARCH.tar.xz" \
    | tar -xJ --strip-components=1

  chmod +x "$NODE_BIN"
fi

# ===============================
# 3. Clone / Update repo
# ===============================
if [ ! -d "$BASE/.git" ]; then
  echo "📦 Cloning repo"
  git clone https://github.com/buithanhquang052008-cloud/roblox-rejoin.git "$BASE"
else
  echo "🔄 Updating repo"
  cd "$BASE"
  git pull --ff-only
fi

# ===============================
# 4. npm install (if needed)
# ===============================
cd "$BASE"
if [ ! -d node_modules ]; then
  echo "📥 Installing dependencies"
  "$NODE_BIN" npm install
fi

echo "✅ Loader done"
echo "👉 Run tool with:"
echo "   bash $BASE/run.sh"
