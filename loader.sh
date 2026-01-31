#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "🚀 Roblox Rejoin Loader (curl | bash safe)"

# ===== Fix dpkg nếu hệ thống từng lỗi =====
dpkg --configure -a || true
apt --fix-broken install -y || true

# ===== Update nhẹ (KHÔNG upgrade) =====
pkg update -y

# ===== Cài dependency bắt buộc =====
pkg install -y nodejs npm sqlite git

# ===== Check sqlite3 =====
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "❌ sqlite3 chưa cài được"
  exit 1
fi

# ===== Clone / update repo =====
TOOL_DIR="$HOME/roblox-rejoin"
REPO_URL="https://github.com/buithanhquang052008-cloud/roblox-rejoin.git"

if [ ! -d "$TOOL_DIR/.git" ]; then
  echo "[+] Clone repo..."
  git clone "$REPO_URL" "$TOOL_DIR"
else
  echo "[+] Update repo..."
  cd "$TOOL_DIR"
  git reset --hard
  git pull
fi

cd "$TOOL_DIR"

# ===== Cài npm package =====
npm install --no-audit --no-fund

chmod +x rejoin.cjs

echo "✅ Setup hoàn tất – chạy tool"
node rejoin.cjsnode rejoin.cjsnpm install --no-audit --no-fund

# ===== Quyền chạy =====
chmod +x rejoin.cjs

# ===== Chạy tool =====
echo "✅ Setup hoàn tất! Đang chạy tool..."
node rejoin.cjs# =========================
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[+] Clone repo..."
  git clone "$REPO_URL" "$REPO_DIR"
else
  echo "[+] Update repo..."
  cd "$REPO_DIR"
  git reset --hard
  git pull
fi

cd "$REPO_DIR"

# =========================
# Cài npm package
# =========================
echo "[+] npm install..."
npm install

# =========================
# Export sqlite bin cho Node
# =========================
export SQLITE_BIN=sqlite3

# =========================
# Chạy tool
# =========================
echo "[✓] Chạy Roblox Rejoin Tool"
node rejoin.cjs
