#!/bin/bash
REPO_URL="https://github.com/buithanhquang052008-cloud/roblox-rejoin";REPO_DIR="$HOME/roblox-rejoin";WORK_DIR="$REPO_DIR";LOADER_PATH="/data/data/com.termux/files/usr/bin/loader"
[ ! -f "$LOADER_PATH" ]&&{ echo "Tạo 'loader'...";cp "$0" "$LOADER_PATH"&&chmod +x "$LOADER_PATH"&&echo "Xong! Lần sau chỉ cần gõ: loader"||echo "Không thể tạo loader"; }
command -v git>/dev/null||{ echo "Cài git...";pkg update -y&&pkg install -y git||{ echo "Cài git thất bại";exit 1;}; }
[ ! -d "$REPO_DIR/.git" ]&&{ echo "Clone repo lần đầu...";git clone "$REPO_URL" "$REPO_DIR"||{ echo "Clone thất bại";exit 1;}; }||{ echo "Pull repo...";cd "$REPO_DIR";git reset --hard;git pull; }
NODE_PATH="/data/data/com.termux/files/usr/bin/node";[ ! -x "$NODE_PATH" ]&&{ pkg install -y which>/dev/null 2>&1;NODE_PATH=$(which node); }
[ -z "$NODE_PATH" ]&&{ echo "Cài Node.js...";pkg update -y&&pkg upgrade -y&&pkg install -y nodejs;NODE_PATH=$(which node);[ -z "$NODE_PATH" ]&&{ echo "Cài Node.js thất bại";exit 1; }||echo "Đã cài Node.js xong"; }
SU_PATH=$(which su);[ -n "$SU_PATH" ]&&{ echo "Thêm alias node...";echo "alias node='$NODE_PATH'" >> ~/.bashrc;echo "export PATH=\"$(dirname $NODE_PATH):\$PATH\"" >> ~/.bashrc;source ~/.bashrc 2>/dev/null||true; }
[ ! -d "$REPO_DIR/node_modules" ]&&{ echo "Chưa có node_modules, đang npm install...";cd "$REPO_DIR";npm install||{ echo "npm install lỗi";exit 1;};echo "npm install thành công"; }
cd "$WORK_DIR";echo "Chạy rejoin.cjs...";"$NODE_PATH" rejoin.cjs
