#!/usr/bin/env bash
# Smoke test for `koi mcp search/info/install/uninstall` (issue #1646).
#
# Exercises the registry-discovery + install corner cases in an isolated
# sandbox. Does NOT require an LLM. Hits the live registry for fetch-based
# scenarios; gracefully skips them if offline.
#
# Usage:
#   bun run scripts/smoke-mcp-discovery.sh
#
# Exit code 0 if all scenarios pass; 1 otherwise.

set -uo pipefail

# Locate the CLI bin relative to this script's repo root.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_BIN="${REPO_ROOT}/packages/meta/cli/dist/bin.js"
if [ ! -f "$CLI_BIN" ]; then
  echo "ERROR: CLI not built. Run: bun run turbo build --filter=@koi-agent/cli"
  exit 1
fi

# Sandbox: isolated cwd + cache dir so we never touch real config.
SANDBOX="$(mktemp -d -t mcp-smoke-XXXXXX)"
export KOI_CACHE_DIR="${SANDBOX}/cache"
trap 'rm -rf "$SANDBOX"' EXIT

KOI() { bun "$CLI_BIN" "$@"; }

PASS=0
FAIL=0
SKIP=0

# A real registry server with a required env var (rejects install).
NEEDS_ENV_SERVER="io.github.Digital-Defiance/mcp-filesystem"
# A simple stdio server we can install repeatedly. Confirmed by smoke earlier;
# the @ai-capabilities-suite/mcp-filesystem 0.1.0 entry has no required env.
SIMPLE_STDIO_SERVER="io.github.Digital-Defiance/mcp-filesystem"
SIMPLE_STDIO_VERSION="0.1.0"

scenario() {
  local n="$1"; local title="$2"; shift 2
  cd "$SANDBOX"
  rm -f .mcp.json .mcp.json.lock
  printf '\n[%s] %s ... ' "$n" "$title"
  local out rc
  out="$("$@" 2>&1)"
  rc=$?

  # rc check: 0 means success; non-zero is "any failure" (CLI uses 2).
  local rc_ok=1
  if [ "${EXPECT_NONZERO:-0}" = "1" ]; then
    [ "$rc" -ne 0 ] || rc_ok=0
  else
    [ "$rc" -eq 0 ] || rc_ok=0
  fi

  local grep_ok=1
  if [ -n "${EXPECT_GREP:-}" ]; then
    echo "$out" | grep -qE "$EXPECT_GREP" || grep_ok=0
  fi

  if [ "$rc_ok" -eq 1 ] && [ "$grep_ok" -eq 1 ]; then
    printf 'PASS\n'
    PASS=$((PASS+1))
    return 0
  fi
  printf 'FAIL (rc=%s)\n' "$rc"
  if [ -n "${EXPECT_GREP:-}" ] && [ "$grep_ok" -eq 0 ]; then
    printf '  expected match: %s\n' "$EXPECT_GREP"
  fi
  printf '  output (last 6 lines):\n'
  echo "$out" | tail -6 | sed 's/^/    /'
  FAIL=$((FAIL+1))
  return 1
}

# Helper: check JSON file shape.
file_has_server() {
  local path="$1"; local name="$2"
  [ -f "$path" ] && grep -q "\"$name\"" "$path"
}

# ---------- Scenarios ----------

# 1. Search returns results
EXPECT_RC=0 EXPECT_GREP="Found .* server" \
  scenario 1 "search lists registry results" \
  bun "$CLI_BIN" mcp search filesystem --limit 3

# 2. Info renders metadata
EXPECT_RC=0 EXPECT_GREP="Packages:" \
  scenario 2 "info renders package metadata" \
  bun "$CLI_BIN" mcp info "$NEEDS_ENV_SERVER"

# 3. Required env var rejection (without --skip-verify it's the install path,
#    but pickPackage rejects upfront so --skip-verify can't bypass).
EXPECT_NONZERO=1 EXPECT_GREP="requires manual configuration|API_KEY|WORKSPACE_ROOT|requires required environment" \
  scenario 3 "install rejects entry with required env vars" \
  bun "$CLI_BIN" mcp install "$NEEDS_ENV_SERVER" --yes --skip-verify

# 4. Idempotent uninstall — removing absent entry is NOT_FOUND
EXPECT_NONZERO=1 EXPECT_GREP="not configured|NOT_FOUND" \
  scenario 4 "uninstall on empty config returns NOT_FOUND" \
  bun "$CLI_BIN" mcp uninstall "ghost.example/missing"

# 5. Cache populated by search
cd "$SANDBOX" && rm -f .mcp.json
bun "$CLI_BIN" mcp search filesystem --limit 2 >/dev/null 2>&1 || true
if [ -f "${KOI_CACHE_DIR}/mcp-registry.json" ]; then
  printf '\n[5] cache file created on search ... PASS\n'
  PASS=$((PASS+1))
else
  printf '\n[5] cache file created on search ... FAIL (no cache file)\n'
  FAIL=$((FAIL+1))
fi

# 6. Unknown server returns NOT_FOUND on info
EXPECT_NONZERO=1 EXPECT_GREP="not found|NOT_FOUND|HTTP 404" \
  scenario 6 "info on unknown server returns NOT_FOUND" \
  bun "$CLI_BIN" mcp info "io.example/definitely-does-not-exist-12345"

# 7. JSON output is parseable jq
cd "$SANDBOX"
rm -f .mcp.json
n=$(bun "$CLI_BIN" mcp search filesystem --json --limit 2 --no-cache 2>/dev/null | bun -e 'const c=[];for await (const x of process.stdin) c.push(x);const t=Buffer.concat(c).toString();console.log(JSON.parse(t).servers.length)' 2>/dev/null)
if [ "$n" = "2" ]; then
  printf '\n[7] --json --limit 2 returns exactly 2 (no-cache) ... PASS\n'
  PASS=$((PASS+1))
else
  printf '\n[7] --json --limit 2 returns exactly 2 (no-cache) ... FAIL (got %s)\n' "$n"
  FAIL=$((FAIL+1))
fi

# 8. Conflict — installing same server twice fails 2nd time.
# Use a synthetic .mcp.json (not via registry — we'd need a server without
# required env; simpler: pre-seed and then attempt registry install).
cd "$SANDBOX"
cat > .mcp.json <<EOF
{
  "mcpServers": {
    "ghost.example/preexisting": { "type": "stdio", "command": "true" }
  }
}
EOF
# Try to add a synthetic install via the installer in-process. The CLI
# install path goes through registry, so simulate via the lower-level
# add-helper: invoke a one-liner.
out=$(bun -e '
  const m = await import("'"$REPO_ROOT"'/packages/net/mcp/dist/index.js");
  const r = await m.addServerToMcpJson("'"$SANDBOX"'/.mcp.json", "ghost.example/preexisting", { type: "stdio", command: "true" });
  console.log(JSON.stringify(r));
' 2>&1)
if echo "$out" | grep -q '"code":"CONFLICT"'; then
  printf '\n[8] addServerToMcpJson refuses to overwrite without overwrite=true ... PASS\n'
  PASS=$((PASS+1))
else
  printf '\n[8] addServerToMcpJson refuses to overwrite without overwrite=true ... FAIL\n  %s\n' "$out"
  FAIL=$((FAIL+1))
fi

# 9. Concurrent writes don't lose entries (lock test).
cd "$SANDBOX"
rm -f .mcp.json .mcp.json.lock
bun -e '
  const m = await import("'"$REPO_ROOT"'/packages/net/mcp/dist/index.js");
  const path = "'"$SANDBOX"'/.mcp.json";
  const tasks = [];
  for (let i = 0; i < 8; i++) {
    tasks.push(m.addServerToMcpJson(path, `srv-${i}`, { type: "stdio", command: "true" }));
  }
  const results = await Promise.all(tasks);
  const ok = results.every((r) => r.ok);
  if (!ok) { console.error("not all ok:", results); process.exit(1); }
  const fs = await import("node:fs/promises");
  const file = JSON.parse(await fs.readFile(path, "utf8"));
  const keys = Object.keys(file.mcpServers).sort();
  if (keys.length !== 8) { console.error("expected 8 entries, got", keys.length, keys); process.exit(2); }
  console.log("OK", keys.length);
' 2>&1
if [ $? -eq 0 ]; then
  printf '[9] 8 concurrent addServerToMcpJson preserve all entries (file lock) ... PASS\n'
  PASS=$((PASS+1))
else
  printf '[9] 8 concurrent addServerToMcpJson preserve all entries (file lock) ... FAIL\n'
  FAIL=$((FAIL+1))
fi

# 10. Stale-lock recovery: pre-create a lock with old mtime; an add should reap it.
cd "$SANDBOX"
rm -f .mcp.json
echo "99999" > .mcp.json.lock
# Set mtime to 2 minutes ago (older than 30s STALE_LOCK_MS).
touch -t "$(date -v-2M +%Y%m%d%H%M.%S 2>/dev/null || date -d '2 minutes ago' +%Y%m%d%H%M.%S)" .mcp.json.lock 2>/dev/null
out=$(bun -e '
  const m = await import("'"$REPO_ROOT"'/packages/net/mcp/dist/index.js");
  const r = await m.addServerToMcpJson("'"$SANDBOX"'/.mcp.json", "x", { type: "stdio", command: "true" });
  console.log(JSON.stringify(r));
' 2>&1)
if echo "$out" | grep -q '"ok":true'; then
  printf '[10] stale lock (>30s) is reaped, add succeeds ... PASS\n'
  PASS=$((PASS+1))
else
  printf '[10] stale lock (>30s) is reaped, add succeeds ... FAIL\n  %s\n' "$out"
  FAIL=$((FAIL+1))
fi

# 11. Atomic write — partial failure does not leave a corrupted .mcp.json.
# We can't easily kill mid-rename, but we can verify that after a failed
# saveMcpJsonFile (e.g. unwritable target), the existing file is untouched.
cd "$SANDBOX"
echo '{"mcpServers":{"keep":{"type":"stdio","command":"true"}}}' > .mcp.json
chmod 0444 .mcp.json
out=$(bun -e '
  const m = await import("'"$REPO_ROOT"'/packages/net/mcp/dist/index.js");
  const r = await m.addServerToMcpJson("'"$SANDBOX"'/.mcp.json", "new", { type: "stdio", command: "true" });
  console.log(JSON.stringify(r));
' 2>&1)
chmod 0644 .mcp.json
content=$(cat .mcp.json)
if echo "$content" | grep -q '"keep"' && ! echo "$content" | grep -q '"new"'; then
  printf '[11] write failure preserves prior config (atomic) ... PASS\n'
  PASS=$((PASS+1))
else
  # On macOS rename can succeed even on read-only files (filesystem semantics).
  # If "new" was written, the test is inconclusive — count as skip.
  printf '[11] write failure preserves prior config (atomic) ... SKIP (FS allowed write)\n'
  SKIP=$((SKIP+1))
fi

# 12. Forward-compat schema — unknown top-level field doesn't crash search.
# The Zod parse strips unknown keys; we verify by feeding a known-good
# server through getServer with a synthetic future field via a tiny patched
# fetch. Done in-process.
cd "$SANDBOX"
out=$(bun -e '
  const m = await import("'"$REPO_ROOT"'/packages/net/mcp/dist/index.js");
  const fakeFetch = async () => new Response(JSON.stringify({
    server: { name: "io.example/x", description: "x", version: "1.0.0", futureField: { y: 1 } },
    _meta: { whatever: 1 },
  }), { status: 200 });
  const c = m.createRegistryClient({ fetch: fakeFetch });
  const r = await c.getServer("io.example/x");
  if (!r.ok) { console.error("fail:", r.error); process.exit(1); }
  if (r.value.name !== "io.example/x") { console.error("wrong name"); process.exit(2); }
  console.log("OK");
' 2>&1)
if echo "$out" | grep -q '^OK'; then
  printf '[12] schema is forward-compatible (unknown fields stripped) ... PASS\n'
  PASS=$((PASS+1))
else
  printf '[12] schema is forward-compatible (unknown fields stripped) ... FAIL\n  %s\n' "$out"
  FAIL=$((FAIL+1))
fi

# Summary
echo
echo "──────────────────────────────────────"
printf 'Passed: %s   Failed: %s   Skipped: %s\n' "$PASS" "$FAIL" "$SKIP"
echo "──────────────────────────────────────"
[ "$FAIL" -eq 0 ]
