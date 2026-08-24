#!/usr/bin/env bash
# ============================================================================
#  Rejoin Pro Max - loader / bootstrap
#  Cai dat moi truong, kiem tra phu thuoc va khoi chay rejoin.cjs
#  Chay duoc tren Termux (Android) va Linux thuong.
#
#  Cach dung:
#    bash loader.sh              # kiem tra + chay tool
#    bash loader.sh --setup      # chi cai dat, khong chay
#    bash loader.sh --check      # chi chan doan moi truong
#    bash loader.sh --repair     # cai lai toan bo node_modules
#    bash loader.sh --help
# ============================================================================

set -uo pipefail

# ---------------------------------------------------------------- cau hinh --
APP_NAME="Rejoin Pro Max"
ENTRY="rejoin.cjs"
NODE_MIN_MAJOR=16
DEPS=(sqlite3 axios cli-table3 figlet)
# Registry du phong - phien truoc npm mac proxy nen phai doi registry
REGISTRIES=(
  "https://registry.npmjs.org"
  "https://registry.npmmirror.com"
  "https://mirrors.cloud.tencent.com/npm"
)

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# ------------------------------------------------------------------- mau ---
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_B=$'\033[1m'
  C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_C=$'\033[36m'
else
  C_RESET=""; C_DIM=""; C_B=""; C_R=""; C_G=""; C_Y=""; C_C=""
fi

info()  { printf '%s[*]%s %s\n' "$C_C" "$C_RESET" "$*"; }
ok()    { printf '%s[+]%s %s\n' "$C_G" "$C_RESET" "$*"; }
warn()  { printf '%s[!]%s %s\n' "$C_Y" "$C_RESET" "$*"; }
err()   { printf '%s[x]%s %s\n' "$C_R" "$C_RESET" "$*" >&2; }
line()  { printf '%s%s%s\n' "$C_DIM" "----------------------------------------------------------------" "$C_RESET"; }

banner() {
  printf '\n%s%s  %s%s\n' "$C_B" "$C_C" "$APP_NAME" "$C_RESET"
  printf '%s  loader v1.0 - bootstrap & launcher%s\n' "$C_DIM" "$C_RESET"
  line
}

# --------------------------------------------------------------- moi truong -
IS_TERMUX=0
if [ -n "${PREFIX:-}" ] && printf '%s' "$PREFIX" | grep -q "com.termux"; then
  IS_TERMUX=1
fi

have() { command -v "$1" >/dev/null 2>&1; }

pkg_install() {
  # $@ = ten goi he thong
  if [ "$IS_TERMUX" -eq 1 ]; then
    pkg install -y "$@" >/dev/null 2>&1
  elif have apt-get; then
    (sudo apt-get install -y "$@" >/dev/null 2>&1) || apt-get install -y "$@" >/dev/null 2>&1
  elif have dnf; then
    (sudo dnf install -y "$@" >/dev/null 2>&1) || dnf install -y "$@" >/dev/null 2>&1
  elif have pacman; then
    (sudo pacman -Sy --noconfirm "$@" >/dev/null 2>&1) || pacman -Sy --noconfirm "$@" >/dev/null 2>&1
  else
    return 1
  fi
}

# --------------------------------------------------------------- kiem tra ---
check_entry() {
  if [ ! -f "$ENTRY" ]; then
    err "Khong tim thay $ENTRY trong: $SCRIPT_DIR"
    err "Dat loader.sh cung thu muc voi $ENTRY roi chay lai."
    exit 1
  fi
  ok "Tim thay $ENTRY ($(wc -l < "$ENTRY" | tr -d ' ') dong)"
}

check_node() {
  if ! have node; then
    warn "Chua co Node.js - dang cai..."
    if [ "$IS_TERMUX" -eq 1 ]; then
      pkg_install nodejs-lts || pkg_install nodejs
    else
      pkg_install nodejs npm
    fi
  fi
  if ! have node; then
    err "Cai Node.js that bai. Tren Termux chay tay: pkg install nodejs-lts"
    exit 1
  fi
  local v major
  v="$(node -v 2>/dev/null | sed 's/^v//')"
  major="${v%%.*}"
  if [ -z "$major" ] || [ "$major" -lt "$NODE_MIN_MAJOR" ] 2>/dev/null; then
    err "Node v$v qua cu - can >= v$NODE_MIN_MAJOR"
    exit 1
  fi
  ok "Node v$v"
  have npm && ok "npm v$(npm -v 2>/dev/null)" || { err "Thieu npm"; exit 1; }
}

check_build_tools() {
  # sqlite3 co the phai build tu source neu khong co prebuilt cho arm64/Android
  local missing=()
  for t in python3 make; do have "$t" || missing+=("$t"); done
  have clang || have gcc || missing+=("clang")
  if [ "${#missing[@]}" -gt 0 ]; then
    warn "Thieu build tools (${missing[*]}) - can khi sqlite3 phai build tu source"
    if [ "$IS_TERMUX" -eq 1 ]; then
      pkg_install python clang make pkg-config binutils || warn "Cai build tools that bai - thu lai bang tay neu sqlite3 loi"
    else
      pkg_install python3 build-essential || warn "Cai build tools that bai"
    fi
  else
    ok "Build tools san sang"
  fi
}

missing_deps() {
  local miss=()
  for d in "${DEPS[@]}"; do
    node -e "require.resolve('$d')" >/dev/null 2>&1 || miss+=("$d")
  done
  printf '%s\n' "${miss[@]:-}"
}

install_deps() {
  local to_install=("$@")
  [ "${#to_install[@]}" -eq 0 ] && return 0

  [ -f package.json ] || {
    info "Tao package.json"
    node -e 'require("fs").writeFileSync("package.json", JSON.stringify({name:"rejoin-promax",private:true,version:"1.0.0"},null,2))'
  }

  local reg
  for reg in "${REGISTRIES[@]}"; do
    info "Cai ${to_install[*]} qua $reg"
    if npm install --no-audit --no-fund --loglevel=error \
         --registry="$reg" "${to_install[@]}" 2>&1 | tail -n 3; then
      # xac minh that su load duoc
      local still
      still="$(missing_deps | tr -d '\n')"
      if [ -z "$still" ]; then
        ok "Cai phu thuoc xong"
        return 0
      fi
      warn "Van thieu: $still - thu registry khac"
    else
      warn "Registry $reg that bai - thu cai khac"
    fi
  done

  err "Khong cai duoc phu thuoc. Kiem tra mang/proxy roi chay: bash loader.sh --repair"
  return 1
}

check_syntax() {
  if node --check "$ENTRY" 2>/tmp/_rejoin_syntax.log; then
    ok "Cu phap $ENTRY hop le"
  else
    err "Loi cu phap trong $ENTRY:"
    cat /tmp/_rejoin_syntax.log >&2
    rm -f /tmp/_rejoin_syntax.log
    exit 1
  fi
  rm -f /tmp/_rejoin_syntax.log
}

check_runtime_extras() {
  # cac thu khong bat buoc nhung anh huong tinh nang
  have sqlite3 && ok "sqlite3 CLI co san (doc cookie du phong)" \
                || warn "Khong co sqlite3 CLI - chi dung module node sqlite3"
  have am && ok "am co san (khoi chay app Roblox)" \
           || warn "Khong thay lenh 'am' - chuc nang rejoin can chay tren Android/Termux"
  have screencap && ok "screencap co san (chup man hinh)" \
                  || warn "Khong co screencap - tat tinh nang chup man hinh trong menu"
  have curl && ok "curl co san" || warn "Khong co curl - webhook van dung axios"
}

prepare_dirs() {
  mkdir -p .tmp
  chmod 700 .tmp 2>/dev/null || true
  ok "Thu muc tam .tmp/ san sang (chmod 700)"
}

# ------------------------------------------------------------------ luong ---
do_check() {
  banner
  info "He dieu hanh: $([ "$IS_TERMUX" -eq 1 ] && echo "Termux/Android" || echo "$(uname -s) $(uname -m)")"
  check_entry
  check_node
  local miss
  miss="$(missing_deps | tr '\n' ' ' | sed 's/ *$//')"
  if [ -z "$miss" ]; then
    ok "Du phu thuoc: ${DEPS[*]}"
  else
    warn "Thieu phu thuoc: $miss"
  fi
  check_runtime_extras
  line
}

do_setup() {
  banner
  check_entry
  check_node
  check_build_tools
  prepare_dirs
  local miss
  # shellcheck disable=SC2207
  miss=($(missing_deps))
  if [ "${#miss[@]}" -eq 0 ] || [ -z "${miss[0]:-}" ]; then
    ok "Phu thuoc da day du"
  else
    install_deps "${miss[@]}" || exit 1
  fi
  check_syntax
  line
  ok "Setup hoan tat"
}

do_repair() {
  banner
  warn "Xoa node_modules va package-lock.json roi cai lai"
  rm -rf node_modules package-lock.json
  do_setup
}

do_run() {
  do_setup
  line
  info "Khoi chay $APP_NAME..."
  echo
  exec node "$ENTRY" "$@"
}

usage() {
  cat <<EOF
$APP_NAME - loader

  bash loader.sh            Kiem tra, cai dat neu thieu, roi chay tool
  bash loader.sh --setup    Chi cai dat moi truong
  bash loader.sh --check    Chi chan doan, khong sua gi
  bash loader.sh --repair   Xoa node_modules va cai lai tu dau
  bash loader.sh --help     Hien tro giup nay

Moi tham so khac se duoc chuyen thang cho $ENTRY.
EOF
}

case "${1:-}" in
  --help|-h) usage ;;
  --check)   do_check ;;
  --setup)   do_setup ;;
  --repair)  do_repair ;;
  *)         do_run "$@" ;;
esac
