#!/data/data/com.termux/files/usr/bin/bash
set -e

REPO_URL="https://github.com/buithanhquang052008-cloud/roblox-rejoin.git"
REPO_DIR="$HOME/roblox-rejoin"
BIN_DIR="$PREFIX/bin"
LOADER_PATH="$BIN_DIR/loader"

echo "🚀 Roblox Rejoin Loader"

# 1️⃣ Tự cài loader command
if [ ! -f "$LOADER_PATH" ]; then
  echo "➕ Tạo lệnh loader..."
  cp "$0" "$LOADER_PATH"
  chmod +x "$LOADER_PATH"
  echo "✅ Đã tạo! Lần sau chỉ cần gõ: loader"
fi

# 2️⃣ Fix dpkg nếu bị kẹt
dpkg --configure -a || true
apt --fix-broken install -y || true

# 3️⃣ Cài dependency hệ thống
pkg update -y
pkg install -y git nodejs npm sqlite

# 4️⃣ Clone / update repo
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "📥 Clone repo lần đầu..."
  git clone "$REPO_URL" "$REPO_DIR"
else
  echo "🔄 Update repo..."
  cd "$REPO_DIR"
  git reset --hard
  git pull
fi

cd "$REPO_DIR"

# 5️⃣ Cài node_modules
if [ ! -d "node_modules" ]; then
  echo "📦 npm install..."
  npm install --no-audit --no-fund
fi

# 6️⃣ Chạy tool (FIX LỖI rejoin.cjsnode)
chmod +x rejoin.cjs
echo "✅ Chạy rejoin.cjs"
node rejoin.cjs
