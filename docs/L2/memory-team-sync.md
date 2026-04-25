# @koi/memory-team-sync

Team memory sync safety boundary — type filtering, secret scanning, and
fail-closed sync stub. Transport deferred.

## How It Works

`syncTeamMemories(config)` validates and filters memories before sync:

1. Returns early (`skipped: true`) if no `remoteEndpoint` configured
2. Lists local memories
3. Filters by allowed types (default: feedback, project, reference)
4. Always denies `MemoryType: "user"` — private by design
5. Scans content, name, and description for secrets via `@koi/redaction`
6. Blocks any memory with detected secrets or scan errors (fail-closed)
7. Reports eligible/blocked counts (transport is a no-op stub)

## Safety

- `"user"` type always denied regardless of `allowedTypes` config — primary contact privacy boundary
- `"reference"` memories containing email addresses are blocked as a misclassification backstop: if the LLM stores a personal contact (e.g. `alice@example.com`) as a reference pointer instead of `user`, it is caught at the sync boundary. SSH git remotes (`git@host:path`) are excluded via a `(?!:)` lookahead in the email pattern. The regex uses unescaped hyphens in character classes per POSIX convention.
- `feedback`/`project` memories may carry shared operational aliases (oncall DLs, team mailboxes) — these are intentionally not blocked at the email level to avoid silently dropping valid team guidance.
- Secret scanning uses `@koi/redaction` (13 built-in detectors)
- Fail-closed: scan errors block the memory, never pass through
- Content, name, and description are all scanned

## Configuration

```typescript
import { syncTeamMemories } from "@koi/memory-team-sync";

const result = await syncTeamMemories({
  listMemories: () => store.list(),
  remoteEndpoint: "https://nexus.example.com/sync",
  allowedTypes: ["feedback", "project"],
  agentId: "my-agent",
  teamId: "team-alpha",
});
// result.eligible, result.blocked, result.skipped
```

## Dependencies

- `@koi/core` (L0)
- `@koi/redaction` (L0u)
