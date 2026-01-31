curl -fsSL https://raw.githubusercontent.com/buithanhquang052008-cloud/roblox-rejoin/main/loader.sh | bash
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
