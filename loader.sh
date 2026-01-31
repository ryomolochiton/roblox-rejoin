#!/bin/bash
set -e

REPO_URL="https://github.com/buithanhquang052008-cloud/roblox-rejoin"
REPO_DIR="$HOME/roblox-rejoin"
NODE_DIR="$HOME/.node"
NODE_BIN="$NODE_DIR/bin/node"
LOADER_PATH="/data/data/com.termux/files/usr/bin/loader"

echo "== Roblox Rejoin Loader (NO APT) =="

# 1. Tạo lệnh loader
if [ ! -f "$LOADER_PATH" ]; then
  echo "→ Tạo lệnh loader"
  cp "$0" "$LOADER_PATH"
  chmod +x "$LOADER_PATH"
  echo "✓ Sau này chỉ cần gõ: loader"
fi

# 2. Clone / update repo (KHÔNG dùng git nếu đã có)
if [ ! -d "$REPO_DIR" ]; then
  echo "→ Clone repo (zip)"
  cd "$HOME"
  curl -L "$REPO_URL/archive/refs/heads/main.zip" -o repo.zip
  unzip repo.zip >/dev/null
  mv roblox-rejoin-main roblox-rejoin
  rm repo.zip
else
  echo "→ Repo đã tồn tại, bỏ qua"
fi

# 3. Cài Node.js binary nếu chưa có
if [ ! -x "$NODE_BIN" ]; then
  echo "→ Tải Node.js binary (NO APT)"
  mkdir -p "$NODE_DIR"
  cd "$NODE_DIR"

  # Node 18 LTS – chạy ổn Android 10
  curl -L https://unofficial-builds.nodejs.org/download/release/v18.19.1/node-v18.19.1-linux-arm64.tar.gz -o node.tar.gz \
  || curl -L https://unofficial-builds.nodejs.org/download/release/v18.19.1/node-v18.19.1-linux-armv7l.tar.gz -o node.tar.gz

  tar -xzf node.tar.gz --strip-components=1
  rm node.tar.gz
fi

# 4. Export PATH
export PATH="$NODE_DIR/bin:$PATH"

# 5. Kiểm tra node
echo -n "→ Node version: "
node -v || { echo "❌ Node lỗi"; exit 1; }

# 6. Cài node_modules nếu cần
cd "$REPO_DIR"
if [ ! -d node_modules ]; then
  echo "→ npm install (local)"
  npm install --no-audit --no-fund
fi

# 7. Chạy tool
echo "→ Chạy rejoin.cjs"
node rejoin.cjs
