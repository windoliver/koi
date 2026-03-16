#!/usr/bin/env bash
# Build libghostty-vt as a WASM module for the TUI split-pane terminal emulator.
#
# Prerequisites:
#   - Zig 0.14+ (https://ziglang.org/download/)
#   - Ghostty source (https://github.com/ghostty-org/ghostty)
#
# Usage:
#   GHOSTTY_SRC=/path/to/ghostty ./scripts/build-ghostty-wasm.sh
#
# Output:
#   packages/ui/tui/src/lib/ghostty_vt.wasm
#
# The TUI's ghostty-wasm.ts module loads this file at runtime via Bun.file().
# If the WASM file is not present, the TUI gracefully falls back to plain-text
# terminal rendering (no VT emulation, no color, no cursor movement).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PACKAGE_DIR/src/lib"
OUTPUT_FILE="$OUTPUT_DIR/ghostty_vt.wasm"

# ─── Validate prerequisites ──────────────────────────────────────────

if ! command -v zig &>/dev/null; then
  echo "ERROR: zig not found. Install Zig 0.14+: https://ziglang.org/download/"
  exit 1
fi

if [[ -z "${GHOSTTY_SRC:-}" ]]; then
  echo "ERROR: GHOSTTY_SRC not set. Point it to your ghostty source checkout."
  echo "  git clone https://github.com/ghostty-org/ghostty.git"
  echo "  GHOSTTY_SRC=/path/to/ghostty $0"
  exit 1
fi

if [[ ! -f "$GHOSTTY_SRC/build.zig" ]]; then
  echo "ERROR: $GHOSTTY_SRC/build.zig not found. Is GHOSTTY_SRC correct?"
  exit 1
fi

ZIG_VERSION=$(zig version)
echo "Using Zig $ZIG_VERSION"
echo "Ghostty source: $GHOSTTY_SRC"
echo "Output: $OUTPUT_FILE"

# ─── Build WASM target ───────────────────────────────────────────────

echo ""
echo "Building libghostty-vt WASM..."
cd "$GHOSTTY_SRC"

# Build the VT library for wasm32-wasi target
# This produces a .wasm file with the terminal emulation functions:
#   ghostty_terminal_new, ghostty_terminal_vt_write,
#   ghostty_terminal_resize, ghostty_terminal_scroll_viewport,
#   ghostty_formatter_terminal_new, ghostty_formatter_format_alloc,
#   ghostty_terminal_free, ghostty_formatter_free
zig build lib-vt \
  -Dtarget=wasm32-wasi \
  -Doptimize=ReleaseSmall \
  2>&1

# The output location depends on Ghostty's build.zig configuration
# Common paths to check:
WASM_CANDIDATES=(
  "$GHOSTTY_SRC/zig-out/lib/ghostty_vt.wasm"
  "$GHOSTTY_SRC/zig-out/lib/libghostty_vt.wasm"
  "$GHOSTTY_SRC/zig-out/wasm32-wasi/libghostty_vt.wasm"
)

FOUND=""
for candidate in "${WASM_CANDIDATES[@]}"; do
  if [[ -f "$candidate" ]]; then
    FOUND="$candidate"
    break
  fi
done

if [[ -z "$FOUND" ]]; then
  echo "ERROR: WASM output not found. Checked:"
  for candidate in "${WASM_CANDIDATES[@]}"; do
    echo "  $candidate"
  done
  echo ""
  echo "List zig-out contents:"
  find "$GHOSTTY_SRC/zig-out" -name "*.wasm" 2>/dev/null || echo "  (no .wasm files found)"
  exit 1
fi

# ─── Copy to package ─────────────────────────────────────────────────

cp "$FOUND" "$OUTPUT_FILE"
WASM_SIZE=$(wc -c < "$OUTPUT_FILE" | tr -d ' ')
echo ""
echo "Success: $OUTPUT_FILE ($WASM_SIZE bytes)"
echo ""
echo "The TUI will now use WASM-backed terminal emulation for split panes."
echo "To verify: import { isWasmAvailable } from '@koi/tui'"
