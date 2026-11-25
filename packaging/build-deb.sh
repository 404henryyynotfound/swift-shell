#!/usr/bin/env bash
# Build a sudo-installable .deb for SwiftShell.
# Usage: bash packaging/build-deb.sh [amd64|arm64] [output-dir]
set -euo pipefail

ARCH_INPUT="${1:-amd64}"
OUT_DIR="${2:-dist/packages}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"

case "$ARCH_INPUT" in
  x64|amd64) DEB_ARCH="amd64" ;;
  arm64|aarch64) DEB_ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH_INPUT" >&2; exit 1 ;;
esac

command -v dpkg-deb >/dev/null 2>&1 || { echo "dpkg-deb is required" >&2; exit 1; }

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/swift-shell-deb.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p \
  "$STAGE/DEBIAN" \
  "$STAGE/usr/bin" \
  "$STAGE/usr/lib/swift-shell/bin" \
  "$STAGE/usr/lib/swift-shell/src" \
  "$STAGE/usr/share/doc/swift-shell" \
  "$OUT_DIR"

cat > "$STAGE/DEBIAN/control" <<EOF
Package: swift-shell
Version: $VERSION
Section: shells
Priority: optional
Architecture: $DEB_ARCH
Maintainer: SwiftShell <support@swift-shell.surge.sh>
Homepage: https://swift-shell.surge.sh
Depends: nodejs (>= 18)
Description: The shell language that reads like code
 SwiftShell is a small, dependency-free shell language with variables,
 arrays, functions, pipelines, redirection and a bundled package registry.
 It installs both the 'swift' and 'swiftshell' commands.
EOF

install -m 0644 "$ROOT/bin/"*.js "$STAGE/usr/lib/swift-shell/bin/"
install -m 0644 "$ROOT/src/"*.js "$STAGE/usr/lib/swift-shell/src/"
install -m 0644 "$ROOT/registry.json" "$STAGE/usr/lib/swift-shell/registry.json"
install -m 0644 "$ROOT/package.json" "$STAGE/usr/lib/swift-shell/package.json"
install -m 0644 "$ROOT/README.md" "$STAGE/usr/share/doc/swift-shell/README.md"
install -m 0644 "$ROOT/LICENSE" "$STAGE/usr/share/doc/swift-shell/copyright"
chmod 0755 "$STAGE/usr/lib/swift-shell/bin/"*.js

ln -s ../lib/swift-shell/bin/swift.js "$STAGE/usr/bin/swift"
ln -s ../lib/swift-shell/bin/swiftshell.js "$STAGE/usr/bin/swiftshell"

OUT_FILE="$OUT_DIR/swift-shell_${VERSION}_${DEB_ARCH}.deb"
dpkg-deb --build --root-owner-group "$STAGE" "$OUT_FILE" >/dev/null
sha256sum "$OUT_FILE" > "${OUT_FILE}.sha256"
echo "$OUT_FILE"
