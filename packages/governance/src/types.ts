/**
 * Types for the governance compliance bundle.
 *
 * Defines the full GovernanceStackConfig (preset + scope + middleware fields),
 * deployment presets, scope configuration, and the GovernanceBundle return shape.
 */

import type {
  AuditSink,
  ComponentProvider,
  CredentialComponent,
  FileSystemBackend,
  KoiMiddleware,
  MemoryComponent,
  ScopeEnforcer,
} from "@koi/core";
import type { DelegationManager, DelegationMiddlewareConfig } from "@koi/delegation";
import type { ExecApprovalsConfig } from "@koi/exec-approvals";
import type { AuditMiddlewareConfig } from "@koi/middleware-audit";
import type { GovernanceBackendMiddlewareConfig } from "@koi/middleware-governance-backend";
import type { GuardrailsConfig } from "@koi/middleware-guardrails";
import type { PayMiddlewareConfig } from "@koi/middleware-pay";
import type { PermissionRules, PermissionsMiddlewareConfig } from "@koi/middleware-permissions";
import type { PIIConfig } from "@koi/middleware-pii";
import type { SanitizeMiddlewareConfig } from "@koi/middleware-sanitize";
import type { BrowserDriver } from "@koi/tool-browser";

// ---------------------------------------------------------------------------
// Deployment presets
// ---------------------------------------------------------------------------

/** Deployment preset levels for governance stacks. */
export type GovernancePreset = "open" | "standard" | "strict";

// ---------------------------------------------------------------------------
// Scope configuration
// ---------------------------------------------------------------------------

/** Scope configuration for governed capabilities. */
export interface GovernanceScopeConfig {
  readonly filesystem?:
    | { readonly root: string; readonly mode?: "rw" | "ro" | undefined }
    | undefined;
  readonly browser?:
    | {
        readonly allowedProtocols?: readonly string[] | undefined;
        readonly allowedDomains?: readonly string[] | undefined;
        readonly blockPrivateAddresses?: boolean | undefined;
        readonly trustTier?: "sandbox" | "verified" | "promoted" | undefined;
      }
    | undefined;
  readonly credentials?: { readonly keyPattern: string } | undefined;
  readonly memory?: { readonly namespace: string } | undefined;
}

/** Backend implementations for scope wiring. */
export interface GovernanceScopeBackends {
  readonly filesystem?: FileSystemBackend | undefined;
  readonly browser?: BrowserDriver | undefined;
  readonly credentials?: CredentialComponent | undefined;
  readonly memory?: MemoryComponent | undefined;
  readonly auditSink?: AuditSink | undefined;
}

// ---------------------------------------------------------------------------
// Stack configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the governance compliance stack.
 *
 * All fields are optional. Include only the middleware you need.
 * When `preset` is specified, its defaults are merged under user overrides.
 */
export interface GovernanceStackConfig {
  // ── Meta ──────────────────────────────────────────────────────────────
  /** Deployment preset. Defaults to "open". */
  readonly preset?: GovernancePreset | undefined;
  /** Scope enforcement configuration. */
  readonly scope?: GovernanceScopeConfig | undefined;
  /** Backend implementations for scope wiring. */
  readonly backends?: GovernanceScopeBackends | undefined;
  /** Pluggable scope enforcer (ReBAC, ABAC, etc.). */
  readonly enforcer?: ScopeEnforcer | undefined;

  // ── Permission shorthand ──────────────────────────────────────────────
  /**
   * Pattern-based permission rules shorthand. Mutually exclusive with `permissions`.
   * Creates a pattern permission backend automatically.
   */
  readonly permissionRules?: PermissionRules | undefined;

  // ── Middleware configs (all optional) ─────────────────────────────────
  /** Coarse-grained tool allow/deny/ask rules. Priority 100. */
  readonly permissions?: PermissionsMiddlewareConfig | undefined;
  /** Progressive command allowlisting. Priority 110 (overridden from default). */
  readonly execApprovals?: ExecApprovalsConfig | undefined;
  /** Delegation grant verification. Priority 120 (overridden from default). */
  readonly delegation?: DelegationMiddlewareConfig | undefined;
  /** Pluggable policy evaluation gate. Priority 150. */
  readonly governanceBackend?: GovernanceBackendMiddlewareConfig | undefined;
  /** @deprecated Use @koi/middleware-pay directly. Will be removed next major. */
  readonly pay?: PayMiddlewareConfig | undefined;
  /** Compliance audit logging. Priority 300. */
  readonly audit?: AuditMiddlewareConfig | undefined;
  /** PII detection and redaction. Priority 340. */
  readonly pii?: PIIConfig | undefined;
  /** Content sanitization. Priority 350. */
  readonly sanitize?: SanitizeMiddlewareConfig | undefined;
  /** Output schema validation. Priority 375. */
  readonly guardrails?: GuardrailsConfig | undefined;

  // ── Delegation bridge ──────────────────────────────────────────────────
  /**
   * Delegation bridge: attaches DelegationComponentProvider to agents.
   * Provides delegation_grant/revoke/list tools + DELEGATION ECS component.
   * The manager should be pre-configured with onGrant/onRevoke hooks
   * (e.g., wired to Nexus permissions.grant RPC).
   */
  readonly delegationBridge?: { readonly manager: DelegationManager } | undefined;

  // ── Capability request bridge ──────────────────────────────────────────
  /**
   * Capability request bridge: enables pull-model requests between agents.
   * Requires delegationBridge to also be configured.
   * Adds a ComponentProvider (priority 101) + KoiMiddleware (priority 125).
   */
  readonly capabilityRequest?:
    | {
        readonly approvalTimeoutMs?: number | undefined;
        readonly maxForwardDepth?: number | undefined;
      }
    | undefined;
}

// ---------------------------------------------------------------------------
// Preset spec (DRY via Omit)
// ---------------------------------------------------------------------------

/**
 * Partial config without meta-fields, used for preset definitions.
 * Presets cannot specify preset, backends, enforcer, or pay.
 */
export type GovernancePresetSpec = Partial<
  Omit<GovernanceStackConfig, "preset" | "backends" | "enforcer" | "pay">
>;

// ---------------------------------------------------------------------------
// Resolved metadata
// ---------------------------------------------------------------------------

/** Metadata about the resolved governance stack for inspection. */
export interface ResolvedGovernanceMeta {
  readonly preset: GovernancePreset;
  readonly middlewareCount: number;
  readonly providerCount: number;
  readonly payDeprecated: boolean;
  readonly scopeEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Bundle return value
// ---------------------------------------------------------------------------

/** Return value of createGovernanceStack(). */
export interface GovernanceBundle {
  readonly middlewares: readonly KoiMiddleware[];
  readonly providers: readonly ComponentProvider[];
  readonly config: ResolvedGovernanceMeta;
}
