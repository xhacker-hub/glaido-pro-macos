#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_BUNDLE="$ROOT_DIR/Glaido Pro.app"
HELPER_DIR="$HOME/Library/Application Support/Glaido Reconstructed"

echo "==> Syncing frontend shim into Glaido Pro.app..."
cp "$ROOT_DIR/glaido-reconstructed/public/tauri-shim.js" "$APP_BUNDLE/Contents/Resources/public/tauri-shim.js"

echo "==> Compiling native macOS binary (main.swift)..."
swiftc -O \
  -framework Cocoa \
  -framework WebKit \
  -framework AVFoundation \
  -framework Speech \
  -framework CoreAudio \
  -framework ApplicationServices \
  -lsqlite3 \
  "$ROOT_DIR/glaido-reconstructed/macos-src/main.swift" \
  -o "$APP_BUNDLE/Contents/MacOS/GlaidoReconstructed"

mkdir -p "$HELPER_DIR"
cp "$APP_BUNDLE/Contents/MacOS/GlaidoReconstructed" "$HELPER_DIR/glaido-ax-helper"

echo "==> Signing Glaido Pro.app and helper..."
xattr -cr "$APP_BUNDLE"
codesign --force --deep --sign - "$APP_BUNDLE"
codesign --force --sign - "$HELPER_DIR/glaido-ax-helper"

echo "==> Installing copy into /Applications/Glaido Pro.app..."
rm -rf "/Applications/Glaido Pro.app"
ditto "$APP_BUNDLE" "/Applications/Glaido Pro.app"
xattr -cr "/Applications/Glaido Pro.app"
codesign --force --deep --sign - "/Applications/Glaido Pro.app"

echo "==> Build complete: $APP_BUNDLE and /Applications/Glaido Pro.app"
