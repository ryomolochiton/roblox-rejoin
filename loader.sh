#!/data/data/com.termux/files/usr/bin/bash
set -e

### CONFIG
REPO_URL="https://github.com/buithanhquang052008-cloud/roblox-rejoin"
REPO_DIR="$HOME/roblox-rejoin"

NODE_DIR="$HOME/.node"
NODE_BIN="$NODE_DIR/bin/node"
NPM_BIN="$NODE_DIR/bin/npm"

LOADER_PATH="$PREFIX/bin/loader"

NODE_VERSION="18.19.1"
NODE_TAR="node-v$NODE_VERSION-linux-arm64.tar.xz"
NODE_URL="https://nodejs.org/dist/v$NODE_VERSION/$NODE_TAR"

### TẠO LỆNH loader
if [ ! -f "$LOADER_PATH" ]; then
  cp "$0" "$LOADER_PATH"
  chmod +x "$LOADER_PATH"
  echo "✔ Đã tạo lệnh: loader"
fi

### TẢI NODE BINARY (KHÔNG apt/pkg)
if [ ! -x "$NODE_BIN" ]; then
  echo "📦 Đang tải Node.js binary..."
  mkdir -p "$NODE_DIR"
  cd "$NODE_DIR"

  curl -L "$NODE_URL" -o node.tar.xz
  tar -xf node.tar.xz
  rm node.tar.xz

  mv node-v$NODE_VERSION-linux-arm64/* "$NODE_DIR/"
  rm -rf node-v$NODE_VERSION-linux-arm64

  chmod +x "$NODE_BIN" "$NPM_BIN"
  echo "✔ Node.js đã sẵn sàng"
fi

### EXPORT PATH (không dùng which)
export PATH="$NODE_DIR/bin:$PATH"

### CLONE / UPDATE REPO
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "⬇ Clone repo..."
  git clone "$REPO_URL" "$REPO_DIR"
else
  echo "🔄 Update repo..."
  cd "$REPO_DIR"
  git reset --hard
  git pull
fi

### NPM INSTALL
cd "$REPO_DIR"
if [ ! -d "node_modules" ]; then
  echo "📦 npm install..."
  "$NPM_BIN" install
fi

### CHẠY TOOL
echo "🚀 Chạy Rejoin Tool..."
"$NODE_BIN" rejoin.cjs
