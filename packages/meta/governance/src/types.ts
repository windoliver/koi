/**
 * Types for the governance compliance bundle.
 *
 * Defines the full GovernanceStackConfig (preset + scope + middleware fields),
 * deployment presets, scope configuration, and the GovernanceBundle return shape.
 */

import type { NdjsonAuditSinkConfig, SqliteAuditSinkConfig } from "@koi/audit-sink-local";
import type { NexusAuditSinkConfig } from "@koi/audit-sink-nexus";
import type { SessionRevocationStore } from "@koi/capability-verifier";
import type {
  AuditSink,
  ComponentProvider,
  CredentialComponent,
  FileSystemBackend,
  KoiMiddleware,
  MemoryComponent,
  PermissionBackend,
  ScopeEnforcer,
} from "@koi/core";
import type { DelegationManager, DelegationMiddlewareConfig } from "@koi/delegation";
import type { ExecApprovalsConfig } from "@koi/exec-approvals";
import type { AuditMiddlewareConfig } from "@koi/middleware-audit";
import type {
  DelegationEscalationConfig,
  DelegationEscalationHandle,
} from "@koi/middleware-delegation-escalation";
import type { GovernanceBackendMiddlewareConfig } from "@koi/middleware-governance-backend";
import type { GuardrailsConfig } from "@koi/middleware-guardrails";
import type { IntentCapsuleConfig } from "@koi/middleware-intent-capsule";
import type { PayMiddlewareConfig } from "@koi/middleware-pay";
import type { PermissionRules, PermissionsMiddlewareConfig } from "@koi/middleware-permissions";
import type { PIIConfig } from "@koi/middleware-pii";
import type { SanitizeMiddlewareConfig } from "@koi/middleware-sanitize";
import type { NexusPermissionBackend, OnGrantHook, OnRevokeHook } from "@koi/permissions-nexus";
import type { RedactionConfig, Redactor } from "@koi/redaction";
import type { BrowserDriver } from "@koi/tool-browser";

// ---------------------------------------------------------------------------
// Audit backend config
// ---------------------------------------------------------------------------

/** Declarative audit backend selection — auto-creates the AuditSink and wires it into audit middleware + scope backends. */
export type AuditBackendConfig =
  | ({ readonly kind: "sqlite" } & SqliteAuditSinkConfig)
  | ({ readonly kind: "ndjson" } & NdjsonAuditSinkConfig)
  | ({ readonly kind: "nexus" } & NexusAuditSinkConfig)
  | { readonly kind: "custom"; readonly sink: AuditSink };

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

  // ── Audit backend (declarative) ─────────────────────────────────────
  /**
   * Declarative audit backend. Auto-creates the AuditSink and wires it
   * into audit middleware + scope backends. Mutually exclusive with `audit.sink`.
   */
  readonly auditBackend?: AuditBackendConfig | undefined;

  // ── Middleware configs (all optional) ─────────────────────────────────
  /** Coarse-grained tool allow/deny/ask rules. Priority 100. */
  readonly permissions?: PermissionsMiddlewareConfig | undefined;
  /** Progressive command allowlisting. Priority 110 (overridden from default). */
  readonly execApprovals?: ExecApprovalsConfig | undefined;
  /** Delegation grant verification. Priority 120 (overridden from default). */
  readonly delegation?: DelegationMiddlewareConfig | undefined;
  /** Human escalation on delegatee exhaustion. Priority 130. */
  readonly delegationEscalation?: DelegationEscalationConfig | undefined;
  /** Pluggable policy evaluation gate. Priority 150. */
  readonly governanceBackend?: GovernanceBackendMiddlewareConfig | undefined;
  /** Cost/budget governance. Priority 200. */
  readonly pay?: PayMiddlewareConfig | undefined;
  /** Cryptographic mandate binding (OWASP ASI01 defense). Priority 290. */
  readonly intentCapsule?: IntentCapsuleConfig | undefined;
  /** Compliance audit logging. Priority 300. */
  readonly audit?: AuditMiddlewareConfig | undefined;
  /** PII detection and redaction. Priority 340. */
  readonly pii?: PIIConfig | undefined;
  /** Secret redaction (API keys, credentials, tokens). Priority 345. */
  readonly redaction?: Partial<RedactionConfig> | undefined;
  /** Content sanitization. Priority 350. */
  readonly sanitize?: SanitizeMiddlewareConfig | undefined;
  /** Output schema validation. Priority 375. */
  readonly guardrails?: GuardrailsConfig | undefined;

  // ── Delegation bridge ──────────────────────────────────────────────────
  /**
   * Delegation bridge: attaches DelegationComponentProvider to agents.
   * Provides delegation_grant/revoke/list/check tools + DELEGATION ECS component.
   *
   * - `permissionBackend`: enables escalation prevention + permission_check tool
   * - `nexusBackend`: enables Zanzibar tuple sync via onGrant/onRevoke hooks
   */
  readonly delegationBridge?:
    | {
        readonly manager: DelegationManager;
        readonly permissionBackend?: PermissionBackend;
        readonly nexusBackend?: NexusPermissionBackend;
      }
    | undefined;

  // ── Capability request bridge ──────────────────────────────────────────
  /**
   * Capability request bridge: enables pull-model requests between agents.
   * Requires `delegationBridge` to also be configured — will throw if missing.
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
  Omit<
    GovernanceStackConfig,
    "preset" | "backends" | "enforcer" | "intentCapsule" | "delegationEscalation"
  >
>;

// ---------------------------------------------------------------------------
// Resolved metadata
// ---------------------------------------------------------------------------

/** Metadata about the resolved governance stack for inspection. */
export interface ResolvedGovernanceMeta {
  readonly preset: GovernancePreset;
  readonly middlewareCount: number;
  readonly providerCount: number;
  readonly scopeEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Bundle return value
// ---------------------------------------------------------------------------

/** Nexus delegation hooks for wiring to DelegationManager. */
export interface NexusDelegationHooks {
  readonly onGrant: OnGrantHook;
  readonly onRevoke: OnRevokeHook;
}

/** Return value of createGovernanceStack(). */
export interface GovernanceBundle {
  readonly middlewares: readonly KoiMiddleware[];
  readonly providers: readonly ComponentProvider[];
  readonly config: ResolvedGovernanceMeta;
  /** Disposable resources (e.g., parent-side approval handler subscriptions). */
  readonly disposables: readonly Disposable[];
  /** Nexus delegation hooks — present when `delegationBridge.nexusBackend` is configured. */
  readonly nexusHooks?: NexusDelegationHooks;
  /** Session revocation store — present when strict preset auto-wires capability verifier. */
  readonly sessionStore?: SessionRevocationStore;
  /** Delegation escalation handle — present when `delegationEscalation` is configured. */
  readonly delegationEscalationHandle?: DelegationEscalationHandle;
  /** Compiled redactor — present when `redaction` is configured. */
  readonly redactor?: Redactor;
}
