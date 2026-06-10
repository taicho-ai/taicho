#!/usr/bin/env bash
# taicho installer — https://taicho.ai
set -euo pipefail
REPO="taicho-ai/taicho"
BIN_DIR="${TAICHO_BIN_DIR:-$HOME/.local/bin}"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  TARGET="darwin-arm64" ;;
  Darwin-x86_64) TARGET="darwin-x64" ;;
  Linux-x86_64)  TARGET="linux-x64" ;;
  Linux-aarch64) TARGET="linux-arm64" ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
URL="https://github.com/$REPO/releases/latest/download/taicho-$TARGET"
mkdir -p "$BIN_DIR"
echo "downloading taicho ($TARGET)..."
curl -fsSL "$URL" -o "$BIN_DIR/taicho"
chmod +x "$BIN_DIR/taicho"
echo "installed: $BIN_DIR/taicho"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "note: add $BIN_DIR to your PATH" ;; esac
