import type { ApprovalZone } from "./zone-types.js";

// Tool globs cover both generic spec names (`read`, `write`, `bash`) and the
// prefixed names used by `@koi-agent/cli` (`fs_read`, `fs_write`, `fs_edit`,
// `Bash`, `Glob`, `Grep`). `*` in zone-match.ts matches `[^/]*`, so e.g.
// `*read` matches both `read` and `fs_read`.

export const READ_ONLY_PROFILE: readonly ApprovalZone[] = [
  {
    name: "read-only",
    match: { tools: ["read", "fs_read", "glob", "Glob", "grep", "Grep", "ls"] },
    action: "auto",
    maxRisk: "low",
  },
];

// maxRisk "medium": the default scorer classifies "edit"/"write" as medium
// (MUTATING_TOOLS). Test-file edits are intentionally permitted up to medium.
export const EDIT_TEST_FILES_PROFILE: readonly ApprovalZone[] = [
  {
    name: "edit-test-files",
    match: {
      tools: ["write", "edit", "fs_write", "fs_edit"],
      paths: ["**/*.test.ts", "**/*.test.js", "**/__tests__/**"],
    },
    action: "auto",
    maxRisk: "medium",
  },
];

export const SCRIPTED_CLEANUP_PROFILE: readonly ApprovalZone[] = [
  {
    name: "scripted-cleanup",
    match: { tools: ["bash", "Bash"], paths: ["/tmp/**"] },
    action: "sandbox-then-auto",
    maxRisk: "medium",
    sandboxBackendId: "default",
  },
];
