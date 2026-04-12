# @koi/fs-local — Local FileSystemBackend

Implements the `FileSystemBackend` (L0) contract using `Bun.file()` / `node:fs`. Agents get sandboxed local filesystem access scoped to a workspace root directory.

---

## Why It Exists

Koi agents need local filesystem access for reading, writing, and editing files in their workspace. This package provides a `FileSystemBackend` implementation that:

- Scopes all operations to a root directory (sandbox)
- Prevents path traversal via `..` and symlink containment checks
- Provides atomic writes (`O_EXCL` for conflict detection, temp-file rename for edits)
- Uses the same interface as `@koi/fs-nexus`, enabling seamless backend swapping

---

## Public API

```typescript
import { createLocalFileSystem } from "@koi/fs-local";

const backend = createLocalFileSystem("/path/to/workspace");

// All FileSystemBackend operations
await backend.read("src/index.ts");
await backend.write("output.txt", "content");
await backend.edit("config.ts", [{ oldText: "old", newText: "new" }]);
await backend.list("src");
await backend.search("pattern");
await backend.delete("temp.txt");
await backend.rename("old.ts", "new.ts");
```

---

## Security Model

- **Path containment**: All paths resolved relative to workspace root; `..` traversal rejected
- **Symlink containment**: `realpath` check on nearest existing ancestor; symlinks escaping the workspace are rejected on all operations including search and list
- **Symlink pre-mutation check**: `lstat` on target before write/edit/delete/rename rejects escaping symlinks at point of use
- **Atomic conflict detection**: `overwrite: false` uses `O_EXCL` flag (no TOCTOU race)
- **OCC edits**: mtime comparison before write; temp-file + rename for atomicity

---

## Path Resolution

`resolvePath(userPath)` resolves a user-supplied path against the workspace root and returns the absolute path as a `string` if it is contained within the sandbox, or `undefined` if the path escapes the workspace root (e.g., via `..` traversal or symlink escape). This is used by checkpoint middleware to validate that checkpoint-related paths stay within the workspace boundary before persisting state.

---

## Layer & Dependencies

- **Layer**: L2
- **Imports from**: `@koi/core` (L0) only
- **Runtime dependency**: Bun (uses `Bun.file()`, `Bun.write()`, `Bun.Glob`)
