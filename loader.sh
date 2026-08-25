#!/usr/bin/env bash
# loader.sh - bootstrap cho rejoin.cjs Pro Max (Termux / Linux / WSL)
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\033[36m[loader]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[loader]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[loader]\033[0m %s\n' "$*" >&2; exit 1; }

IS_TERMUX=0
[ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux ] && IS_TERMUX=1

# ---------- 1) Node >= 18 ----------
ensure_node() {
  if ! command -v node >/dev/null 2>&1; then
    if command -v pkg >/dev/null 2>&1; then
      say "Chua co node -> pkg install nodejs-lts"
      pkg install -y nodejs-lts || pkg install -y nodejs || die "Cai node that bai"
    elif command -v apt-get >/dev/null 2>&1; then
      die "Khong co node. Chay: sudo apt-get install -y nodejs npm"
    else
      die "Khong co node. Termux: pkg install nodejs-lts"
    fi
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 18 ]; then
    warn "Node $major < 18: thieu global fetch. Termux: pkg upgrade nodejs-lts"
    die "Dung lai de tranh loi kho hieu trong rejoin.cjs"
  fi
  say "node v$(node -p 'process.versions.node') OK"
}

# ---------- 2) deps (chi optional: figlet) ----------
REGISTRIES=(
  "https://registry.npmjs.org"
  "https://registry.npmmirror.com"
  "https://registry.yarnpkg.com"
)

install_optional() {
  command -v npm >/dev/null 2>&1 || { warn "Khong co npm, bo qua figlet"; return 0; }
  if [ -d node_modules/figlet ]; then say "figlet da co"; return 0; fi
  for r in "${REGISTRIES[@]}"; do
    say "npm i figlet --registry=$r"
    if npm install --no-audit --no-fund --no-save --silent \
        --registry="$r" figlet >/dev/null 2>&1; then
      say "OK qua $r"; return 0
    fi
    warn "registry loi, thu cai khac..."
  done
  warn "Bo qua figlet (khong bat buoc, banner dung chu thuong)"
}

# ---------- 3) config + cookie ----------
ensure_config() {
  if [ ! -f config.json ]; then
    if [ -f config.example.json ]; then
      cp config.example.json config.json
      say "Da tao config.json tu config.example.json"
    else
      warn "Khong thay config.json - rejoin.cjs se dung mac dinh"
      return 0
    fi
  fi
  node -e 'JSON.parse(require("fs").readFileSync("config.json","utf8"))' \
    || die "config.json sai cu phap JSON"
  chmod 600 config.json 2>/dev/null || true
  [ -f cookie.txt ] && chmod 600 cookie.txt 2>/dev/null || true

  if [ -z "${ROBLOSECURITY:-}" ] && [ ! -f cookie.txt ]; then
    warn "Chua co cookie: export ROBLOSECURITY='...' hoac tao file cookie.txt"
  fi
}

ensure_storage() {
  [ "$IS_TERMUX" -eq 1 ] || return 0
  [ -d "$HOME/storage" ] && return 0
  warn "Chay 'termux-setup-storage' neu muon doc cookie tu /sdcard (tuy chon)"
}

# ---------- main ----------
ensure_node
ensure_storage

case "${1:-}" in
  --setup)
    install_optional; ensure_config; exec node rejoin.cjs --diagnostics ;;
  --selftest)
    ensure_config; exec node rejoin.cjs --selftest ;;
  --loop)
    install_optional; ensure_config; exec node rejoin.cjs --loop ;;
  --help|-h)
    cat <<'EOF'
bash loader.sh              # cai deps + mo menu
bash loader.sh --setup      # cai deps + chan doan
bash loader.sh --selftest   # chay self-test
bash loader.sh --loop       # chay thang vong lap
EOF
    ;;
  *)
    install_optional; ensure_config; exec node rejoin.cjs "$@" ;;
esac
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
