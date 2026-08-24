#!/usr/bin/env bash
# loader.sh - bootstrap cho rejoin.cjs Pro Max (Termux)
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\033[36m[loader]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[loader]\033[0m %s\n' "$*" >&2; exit 1; }

# 1) Node
if ! command -v node >/dev/null 2>&1; then
  if command -v pkg >/dev/null 2>&1; then
    say "Chưa có node → pkg install nodejs-lts"
    pkg install -y nodejs-lts || pkg install -y nodejs || die "Cài node thất bại"
  else
    die "Không có node. Termux: pkg install nodejs-lts"
  fi
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || say "CẢNH BÁO: Node $NODE_MAJOR < 18, thiếu fetch → pkg upgrade nodejs"

# 2) deps tuỳ chọn (figlet). Xoay registry khi proxy chặn.
REGISTRIES=(
  "https://registry.npmjs.org"
  "https://registry.npmmirror.com"
  "https://registry.yarnpkg.com"
)
install_optional() {
  [ -d node_modules/figlet ] && { say "figlet đã có"; return 0; }
  for r in "${REGISTRIES[@]}"; do
    say "npm i figlet --registry=$r"
    if npm install --no-audit --no-fund --silent --registry="$r" figlet >/dev/null 2>&1; then
      say "OK qua $r"; return 0
    fi
    say "registry lỗi, thử cái khác…"
  done
  say "Bỏ qua figlet (không bắt buộc, banner sẽ dùng chữ thường)"
}

# 3) storage permission (chỉ Termux)
if [ -n "${TERMUX_VERSION:-}" ] && [ ! -d "$HOME/storage" ]; then
  say "Chạy termux-setup-storage để đọc cookie từ /sdcard (tuỳ chọn)"
fi

case "${1:-}" in
  --setup)    install_optional; node rejoin.cjs --diagnostics ;;
  --selftest) node rejoin.cjs --selftest ;;
  --loop)     node rejoin.cjs --loop ;;
  *)          install_optional; exec node rejoin.cjs "$@" ;;
esac
