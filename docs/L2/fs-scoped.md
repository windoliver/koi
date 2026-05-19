# @koi/fs-scoped

`@koi/fs-scoped` contains L0u filesystem adapters that reduce a broader
`FileSystemBackend` into a smaller authority surface.

## Scoped Filesystems

`createScopedFileSystem(backend, { root, mode })` wraps a backend with a root
boundary and access mode:

- `ro` allows `read`, `list`, and `search`, and blocks `write`, `edit`,
  `delete`, and `rename`.
- `rw` allows the full backend operation set, still constrained to the root.

All path arguments are normalized at call time and rejected if they escape the
compiled root.

## Context Namespaces

`createContextNamespace()` creates an in-memory shared namespace for mounting
filesystem backends under stable namespace paths such as `/shared`.

```ts
import { createContextNamespace } from "@koi/fs-scoped";

const namespace = createContextNamespace();
namespace.mount({ path: "/shared", backend, mode: "rw" });

const shared = namespace.resolve("/shared/note.md");
shared?.write("/shared/note.md", "hello");
```

Namespace resolution uses longest-prefix matching, so `/shared/project/file.ts`
resolves to a `/shared/project` mount before a broader `/shared` mount. The
resolved backend accepts namespace paths and delegates to the mounted backend
with the mount prefix stripped, so `/shared/note.md` reaches the backend as
`/note.md`.

Mount access modes reuse `createScopedFileSystem()` enforcement. Read-only
mounts expose the same backend shape but return `PERMISSION` errors for writes,
edits, deletes, and renames.

Callers may subscribe with `watch(listener)`. The listener receives `mounted`,
`resolved`, and `unmounted` events until the returned unsubscribe function is
called. The namespace object is ordinary shared state, so a parent runtime can
pass the same instance to child runtimes to expose a common `/shared` view
without adding direct agent-to-agent communication.
