/**
 * Governance deployment presets: open, standard, strict.
 *
 * Each preset provides sensible defaults for permission rules,
 * middleware, and scope configuration. User overrides always win.
 */

import type { GovernancePreset, GovernancePresetSpec } from "./types.js";

// ---------------------------------------------------------------------------
// Preset definitions (deeply frozen)
// ---------------------------------------------------------------------------

const OPEN: GovernancePresetSpec = Object.freeze({
  permissionRules: Object.freeze({
    allow: Object.freeze(["*"]),
    deny: Object.freeze([] as readonly string[]),
    ask: Object.freeze([] as readonly string[]),
  }),
});

const STANDARD: GovernancePresetSpec = Object.freeze({
  permissionRules: Object.freeze({
    allow: Object.freeze(["group:fs_read", "group:web", "group:browser", "group:lsp"]),
    deny: Object.freeze(["group:fs_delete"]),
    ask: Object.freeze(["group:runtime"]),
  }),
  pii: Object.freeze({ strategy: "mask" as const }),
  redaction: Object.freeze({}),
  sanitize: Object.freeze({ rules: Object.freeze([] as readonly []) }),
  scope: Object.freeze({
    filesystem: Object.freeze({ root: ".", mode: "rw" as const }),
    browser: Object.freeze({ blockPrivateAddresses: true }),
  }),
});

const STRICT: GovernancePresetSpec = Object.freeze({
  permissionRules: Object.freeze({
    allow: Object.freeze(["group:fs_read"]),
    deny: Object.freeze(["group:runtime", "group:fs_delete", "group:db_write"]),
    ask: Object.freeze([] as readonly string[]),
  }),
  pii: Object.freeze({ strategy: "redact" as const }),
  redaction: Object.freeze({}),
  sanitize: Object.freeze({ rules: Object.freeze([] as readonly []) }),
  guardrails: Object.freeze({ rules: Object.freeze([] as readonly []) }),
  scope: Object.freeze({
    filesystem: Object.freeze({ root: ".", mode: "ro" as const }),
    browser: Object.freeze({
      blockPrivateAddresses: true,
      allowedProtocols: Object.freeze(["https:"]),
    }),
    credentials: Object.freeze({ keyPattern: "*" }),
    memory: Object.freeze({ namespace: "default" }),
  }),
});

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

/** Frozen registry of governance preset specs, keyed by preset name. */
export const GOVERNANCE_PRESET_SPECS: Readonly<Record<GovernancePreset, GovernancePresetSpec>> =
  Object.freeze({ open: OPEN, standard: STANDARD, strict: STRICT });
