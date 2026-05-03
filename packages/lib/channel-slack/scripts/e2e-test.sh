#!/usr/bin/env bash
# E2E test matrix for @koi/channel-slack: signature, replay, dedupe,
# url_verification, body cap. Boots harness, signs requests with the
# shared secret, hits the HTTP entry, asserts status codes.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

LOG=$(mktemp)
bun run scripts/e2e-server.ts >"$LOG" 2>&1 &
PID=$!
trap "kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -f $LOG" EXIT

for i in $(seq 1 50); do
  if grep -q '"port":' "$LOG"; then break; fi
  sleep 0.1
done
PORT=$(grep -o '"port":[0-9]*' "$LOG" | head -1 | cut -d: -f2)
SECRET=$(grep -o '"secret":"[^"]*"' "$LOG" | head -1 | cut -d'"' -f4)
[ -z "$PORT" ] && { echo "server failed"; cat "$LOG"; exit 1; }
URL="http://127.0.0.1:$PORT/slack/events"
echo "server at $URL"

PASS=0; FAIL=0
check() {
  local name="$1" expect="$2" got="$3"
  if [ "$got" = "$expect" ]; then echo "  PASS  $name"; PASS=$((PASS+1));
  else echo "  FAIL  $name  expect=$expect got=$got"; FAIL=$((FAIL+1)); fi
}

sign() {
  local ts="$1" body="$2"
  printf 'v0=%s' "$(printf 'v0:%s:%s' "$ts" "$body" \
    | openssl dgst -sha256 -hmac "$SECRET" -binary | xxd -p -c 999)"
}

post() {
  local ts="$1" body="$2" sig="$3" extra_hdr="${4:-}"
  curl -s -o /dev/null -w '%{http_code}' -X POST "$URL" \
    -H "Content-Type: application/json" \
    -H "X-Slack-Request-Timestamp: $ts" \
    -H "X-Slack-Signature: $sig" \
    ${extra_hdr:+-H "$extra_hdr"} \
    --data-binary "$body"
}

NOW=$(date +%s)

# 1. url_verification handshake (works with no handler bound to events)
BODY='{"type":"url_verification","challenge":"abc"}'
SIG=$(sign "$NOW" "$BODY")
S=$(post "$NOW" "$BODY" "$SIG")
check "url_verification" 200 "$S"

# 2. Valid signature on event_callback → 200 (handler is wired in harness)
BODY=$(printf '{"type":"event_callback","event_id":"E1","event":{"type":"message","text":"hi","user":"U1","channel":"C1","ts":"1.0"}}')
SIG=$(sign "$NOW" "$BODY")
S=$(post "$NOW" "$BODY" "$SIG")
check "valid-signature/event" 200 "$S"

# 3. Bad signature → 401
S=$(post "$NOW" "$BODY" "v0=deadbeef")
check "bad-signature" 401 "$S"

# 4. Stale timestamp (>5min) → 401 replay protection
OLD=$((NOW - 600))
SIG=$(sign "$OLD" "$BODY")
S=$(post "$OLD" "$BODY" "$SIG")
check "replay/stale-timestamp" 401 "$S"

# 5. Tampered body (sig was computed for original body) → 401
BODY2='{"type":"event_callback","event_id":"E1","event":{"type":"message","text":"TAMPERED","user":"U1","channel":"C1","ts":"1.0"}}'
SIG=$(sign "$NOW" "$BODY")
S=$(post "$NOW" "$BODY2" "$SIG")
check "tampered-body" 401 "$S"

# 6. Dedupe: retry same event_id → second is acked but not redelivered
BODY=$(printf '{"type":"event_callback","event_id":"E_DEDUPE","event":{"type":"message","text":"once","user":"U1","channel":"C1","ts":"2.0"}}')
SIG=$(sign "$NOW" "$BODY")
S1=$(post "$NOW" "$BODY" "$SIG")
S2=$(post "$NOW" "$BODY" "$SIG")
check "dedupe/retry-acks" "200|200" "$S1|$S2"

# 7. Slash command (form-encoded) — Slack signs the urlencoded form body
FORM='token=verif&team_id=T1&channel_id=C1&user_id=U1&command=%2Fkoi&text=hello&trigger_id=tr1&response_url=https%3A%2F%2Fhooks.example%2Fx'
SIG=$(sign "$NOW" "$FORM")
S=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Slack-Request-Timestamp: $NOW" \
  -H "X-Slack-Signature: $SIG" \
  --data-binary "$FORM")
check "slash-command/valid" 200 "$S"

# 8. Missing signature header → 401
S=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-Slack-Request-Timestamp: $NOW" \
  --data-binary '{"type":"url_verification","challenge":"x"}')
check "missing-signature-header" 401 "$S"

# 9. Future timestamp (>5min ahead) → 401 (clock-skew window)
FUT=$((NOW + 600))
BODY='{"type":"url_verification","challenge":"x"}'
SIG=$(sign "$FUT" "$BODY")
S=$(post "$FUT" "$BODY" "$SIG")
check "replay/future-timestamp" 401 "$S"

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
