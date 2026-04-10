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

- `"user"` type always denied regardless of `allowedTypes` config
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
