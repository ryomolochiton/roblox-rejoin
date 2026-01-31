#!/usr/bin/env bash

BASE="$HOME/roblox-rejoin"
NODE_BIN="$HOME/.node/bin/node"

if [ ! -x "$NODE_BIN" ]; then
  echo "❌ Node not found. Run loader first."
  exit 1
fi

cd "$BASE"
echo "🚀 Roblox Rejoin Tool"
"$NODE_BIN" rejoin.cjs </dev/tty
