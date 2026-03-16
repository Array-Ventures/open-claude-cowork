#!/bin/bash
# Clawd setup — run this from a terminal NOT opened by Claude Code
# (Claude Code tags files with com.apple.provenance, which blocks sandbox execution)
set -e

WRAPPER_DIR="$HOME/.local/bin"
WRAPPER="$WRAPPER_DIR/obsidian"

mkdir -p "$WRAPPER_DIR"

cat > "$WRAPPER" << 'SCRIPT'
#!/bin/bash
exec /Applications/Obsidian.app/Contents/MacOS/obsidian --no-sandbox "$@"
SCRIPT
chmod +x "$WRAPPER"

# Strip provenance if present (belt and suspenders)
xattr -d com.apple.provenance "$WRAPPER" 2>/dev/null || true

echo "✓ Obsidian wrapper installed at $WRAPPER"
echo "  Provenance: $(xattr "$WRAPPER" 2>/dev/null || echo 'clean')"
