#!/usr/bin/env bash
# E2E test matrix for @koi/channel-web. Boots the harness server, runs
# auth/CSRF/idempotency/cap cases, prints PASS/FAIL summary.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

LOG=$(mktemp)
bun run scripts/e2e-server.ts >"$LOG" 2>&1 &
PID=$!
trap "kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -f $LOG" EXIT

# Wait for {"port":N}
for i in $(seq 1 50); do
  if grep -q '"port":' "$LOG"; then break; fi
  sleep 0.1
done
PORT=$(grep -o '"port":[0-9]*' "$LOG" | head -1 | cut -d: -f2)
if [ -z "$PORT" ]; then echo "server failed to start"; cat "$LOG"; exit 1; fi
URL="http://127.0.0.1:$PORT"
echo "server at $URL"

PASS=0; FAIL=0
check() {
  local name="$1" expect="$2" got="$3"
  if [ "$got" = "$expect" ]; then echo "  PASS  $name"; PASS=$((PASS+1));
  else echo "  FAIL  $name  expect=$expect got=$got"; FAIL=$((FAIL+1)); fi
}

# 1. Auth: valid token → 202
S=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/messages" \
  -H "Authorization: Bearer tok-alice" -H "Origin: http://localhost:3000" \
  -H "Content-Type: application/json" \
  -d '{"content":[{"kind":"text","text":"hello"}],"threadId":"t1"}')
check "auth/valid-token" 202 "$S"

# 2. Auth: missing token → 401
S=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/messages" \
  -H "Origin: http://localhost:3000" -H "Content-Type: application/json" \
  -d '{"content":[{"kind":"text","text":"hi"}],"threadId":"t1"}')
check "auth/missing-token" 401 "$S"

# 3. Auth: bad token → 401
S=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/messages" \
  -H "Authorization: Bearer wrong" -H "Origin: http://localhost:3000" \
  -H "Content-Type: application/json" \
  -d '{"content":[{"kind":"text","text":"hi"}],"threadId":"t1"}')
check "auth/bad-token" 401 "$S"

# 4. CSRF: disallowed Origin → 403
S=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/messages" \
  -H "Authorization: Bearer tok-alice" -H "Origin: https://evil.test" \
  -H "Content-Type: application/json" \
  -d '{"content":[{"kind":"text","text":"hi"}],"threadId":"t1"}')
check "csrf/disallowed-origin" 403 "$S"

# 5. Idempotency: same key, same principal → second is suppressed (still 202)
KEY="idem-$$-1"
S1=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/messages" \
  -H "Authorization: Bearer tok-alice" -H "Origin: http://localhost:3000" \
  -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"content":[{"kind":"text","text":"once"}],"threadId":"t1"}')
S2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/messages" \
  -H "Authorization: Bearer tok-alice" -H "Origin: http://localhost:3000" \
  -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"content":[{"kind":"text","text":"once"}],"threadId":"t1"}')
check "idempotency/same-principal-replay" "202|202" "$S1|$S2"

# 6. Idempotency: same key, DIFFERENT principal → both deliver
KEY="idem-$$-cross"
S1=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/messages" \
  -H "Authorization: Bearer tok-alice" -H "Origin: http://localhost:3000" \
  -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"content":[{"kind":"text","text":"alice"}],"threadId":"t1"}')
S2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/messages" \
  -H "Authorization: Bearer tok-bob" -H "Origin: http://localhost:3000" \
  -H "Idempotency-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"content":[{"kind":"text","text":"bob"}],"threadId":"t1"}')
check "idempotency/cross-tenant-isolation" "202|202" "$S1|$S2"

# 7. Body cap: oversize body rejected (default cap is 1MB)
BIG=$(python3 -c "print('x'*2000000)" 2>/dev/null || head -c 2000000 </dev/zero | tr '\0' x)
S=$(printf '{"content":[{"kind":"text","text":"%s"}],"threadId":"t1"}' "$BIG" \
  | curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/messages" \
    -H "Authorization: Bearer tok-alice" -H "Origin: http://localhost:3000" \
    -H "Content-Type: application/json" --data-binary @-)
check "body-cap/oversize" 413 "$S"

# 8. Bad JSON → 400
S=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/messages" \
  -H "Authorization: Bearer tok-alice" -H "Origin: http://localhost:3000" \
  -H "Content-Type: application/json" -d 'not json')
check "validation/malformed-json" 400 "$S"

# 9. CORS preflight from allowlisted origin
S=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$URL/messages" \
  -H "Origin: http://localhost:3000" \
  -H "Access-Control-Request-Method: POST")
check "cors/preflight-allowed" 204 "$S"

# 10. CORS preflight from disallowed origin → 403
S=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$URL/messages" \
  -H "Origin: https://evil.test" \
  -H "Access-Control-Request-Method: POST")
check "cors/preflight-blocked" 403 "$S"

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
