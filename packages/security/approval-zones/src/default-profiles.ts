import type { ApprovalZone } from "./zone-types.js";

export const READ_ONLY_PROFILE: readonly ApprovalZone[] = [
  {
    name: "read-only",
    match: { tools: ["read", "glob", "grep", "ls"] },
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
      tools: ["write", "edit"],
      paths: ["**/*.test.ts", "**/*.test.js", "**/__tests__/**"],
    },
    action: "auto",
    maxRisk: "medium",
  },
];

export const SCRIPTED_CLEANUP_PROFILE: readonly ApprovalZone[] = [
  {
    name: "scripted-cleanup",
    match: { tools: ["bash"], paths: ["/tmp/**"] },
    action: "sandbox-then-auto",
    maxRisk: "medium",
    sandboxBackendId: "default",
  },
];
