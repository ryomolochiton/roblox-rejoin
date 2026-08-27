#!/bin/bash
pkg(){ yes|command pkg "$@"; }
R="https://github.com/rejoinrobloxd/roblox-rejoin";D="$HOME/roblox-rejoin";W="$D";L="/data/data/com.termux/files/usr/bin/loader"
[ ! -f "$L" ]&&cp "$0" "$L"&&chmod +x "$L"
command -v git>/dev/null||{ pkg update;pkg install git||exit 1; }
[ ! -d "$D/.git" ]&&git clone "$R" "$D"||{ cd "$D"||exit 1;git reset --hard;git pull; }
N="/data/data/com.termux/files/usr/bin/node"
[ ! -x "$N" ]&&{ pkg install which>/dev/null 2>&1;N=$(which node); }
[ -z "$N" ]&&{ pkg update;pkg upgrade;pkg install nodejs;N=$(which node)||exit 1; }
S=$(which su 2>/dev/null);[ -n "$S" ]&&{ echo "alias node='$N'">>~/.bashrc;echo "export PATH=\"$(dirname "$N"):\$PATH\"">>~/.bashrc;source ~/.bashrc 2>/dev/null||true; }
[ ! -d "$D/node_modules" ]&&{ cd "$D"||exit 1;npm install||exit 1; }
cd "$W"||exit 1;"$N" rejoin.cjs
