/**
 * createGovernanceStack — enterprise compliance middleware assembly.
 *
 * Composes up to 12 middleware into a single stack with a fixed priority order.
 * All fields are optional — include only what your deployment needs.
 *
 * Priority order (lower = outer layer, runs first on request):
 *   100  koi:permissions
 *   110  koi:exec-approvals  (overridden from default 100)
 *   120  koi:delegation      (overridden from default undefined/500)
 *   125  koi:capability-request (pull-model delegation requests)
 *   130  koi:delegation-escalation (human escalation on delegatee exhaustion)
 *   150  koi:governance-backend
 *   200  koi:pay
 *   290  koi:intent-capsule  (OWASP ASI01 mandate binding)
 *   300  koi:audit
 *   340  koi:pii
 *   350  koi:sanitize
 *   360  koi:agent-monitor   (behavioral anomaly detection, OWASP ASI10)
 *   375  koi:guardrails
 */

import type { AgentMonitorConfig, AnomalySignal, SessionMetricsSummary } from "@koi/agent-monitor";
import { createAgentMonitorMiddleware } from "@koi/agent-monitor";
import { createNdjsonAuditSink, createSqliteAuditSink } from "@koi/audit-sink-local";
import { createNexusAuditSink } from "@koi/audit-sink-nexus";
import type { SessionRevocationStore } from "@koi/capability-verifier";
import { createCapabilityVerifier, createSessionRevocationStore } from "@koi/capability-verifier";
import type {
  Agent,
  AuditSink,
  ComponentProvider,
  DelegationId,
  MailboxComponent,
  SessionId,
} from "@koi/core";
import { MAILBOX } from "@koi/core";
import type { KoiMiddleware } from "@koi/core/middleware";
import type { DelegationMiddlewareConfig } from "@koi/delegation";
import {
  createCapabilityRequestBridge,
  createDelegationMiddleware,
  createDelegationProvider,
  defaultScopeChecker,
} from "@koi/delegation";
import { createNexusDelegationProvider } from "@koi/delegation-nexus";
import { createNexusDelegationApi, createNexusRestClient } from "@koi/nexus-client";
import type {
  ExecApprovalRequest,
  ExecApprovalsConfig,
  ProgressiveDecision,
} from "@koi/exec-approvals";
import {
  createAgentApprovalHandler,
  createExecApprovalsMiddleware,
  createParentApprovalHandler,
} from "@koi/exec-approvals";
import { createAuditMiddleware } from "@koi/middleware-audit";
import { createDelegationEscalationMiddleware } from "@koi/middleware-delegation-escalation";
import { createGovernanceBackendMiddleware } from "@koi/middleware-governance-backend";
import { createGuardrailsMiddleware } from "@koi/middleware-guardrails";
import { createIntentCapsuleMiddleware } from "@koi/middleware-intent-capsule";
import { createPayMiddleware } from "@koi/middleware-pay";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import { createPIIMiddleware } from "@koi/middleware-pii";
import { createSanitizeMiddleware } from "@koi/middleware-sanitize";
import { createNexusOnGrant, createNexusOnRevoke } from "@koi/permissions-nexus";
import { createRedactor } from "@koi/redaction";
import type { AnomalySignalLike } from "@koi/security-analyzer";
import { createMonitorBridgeAnalyzer, createRulesSecurityAnalyzer } from "@koi/security-analyzer";

import { resolveGovernanceConfig } from "./config-resolution.js";
import { wireGovernanceScope } from "./scope-wiring.js";
import type { AuditBackendConfig, GovernanceBundle, GovernanceStackConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Approval routing provider (auto-discovery)
// ---------------------------------------------------------------------------

/** Priority for approval routing provider — runs after BUNDLED (100) so MAILBOX is available. */
const APPROVAL_ROUTING_PRIORITY = 200;

interface ApprovalRoutingResult {
  readonly provider: ComponentProvider;
  readonly effectiveConfig: ExecApprovalsConfig;
}

/**
 * Create a ComponentProvider that auto-wires agent approval routing during assembly.
 *
 * During attach(agent), the provider discovers:
 *   - agentId from agent.pid.id (always available)
 *   - parentId from agent.pid.parent (present for child agents)
 *   - mailbox from agent.component(MAILBOX) (present when IPC is configured)
 *
 * If parentId + mailbox are found → wires child→parent approval routing.
 * If agentId + mailbox are found → wires parent-side handler for incoming requests.
 *
 * Returns an effectiveConfig with a late-bound onAsk that delegates to a mutable ref.
 * The ref is updated during attach() — justified by the late-binding lifecycle.
 */
function createApprovalRoutingProvider(
  execApprovals: ExecApprovalsConfig,
  disposables: Disposable[],
): ApprovalRoutingResult {
  const userOnAsk = execApprovals.onAsk;

  // Per-agent handler map — keyed by agent ID string for multi-agent safety.
  // In Koi's 1:1 stack-to-agent model, this map typically has 0-1 entries.
  // The map provides defensive correctness if the same stack is shared.
  const agentHandlers = new Map<
    string,
    (req: ExecApprovalRequest) => Promise<ProgressiveDecision>
  >();

  // Per-agent disposable tracking for proper cleanup in detach()
  const agentDisposables = new Map<string, readonly Disposable[]>();

  // Late-binding onAsk — resolves the correct handler per agent at call time.
  // Falls back to user's original onAsk, then to deny_once.
  const dynamicOnAsk = async (req: ExecApprovalRequest): Promise<ProgressiveDecision> => {
    // Route by agentId when the request carries agent identity
    if (req.agentId !== undefined) {
      const targetHandler = agentHandlers.get(req.agentId);
      if (targetHandler !== undefined) {
        return targetHandler(req);
      }
      // agentId provided but no handler found — fall through to fallback
    }
    if (agentHandlers.size > 1) {
      console.warn(
        `[koi:governance] dynamicOnAsk: ${agentHandlers.size} agent handlers registered but ` +
          `ExecApprovalRequest carries no agent identity — routing to first handler is ambiguous. ` +
          `Agent IDs in map: ${[...agentHandlers.keys()].join(", ")}. ` +
          `Consider using a separate governance stack per agent.`,
      );
    }
    // In 1:1 model, the map has one entry. Use the first handler found.
    // When multiple handlers exist, this is ambiguous (warned above).
    for (const handler of agentHandlers.values()) {
      return handler(req);
    }
    // No agent handler wired — fall back to user's onAsk or deny
    if (userOnAsk !== undefined) {
      return userOnAsk(req);
    }
    return { kind: "deny_once", reason: "No approval handler configured" };
  };

  const effectiveConfig: ExecApprovalsConfig = {
    ...execApprovals,
    onAsk: dynamicOnAsk,
  };

  const provider: ComponentProvider = {
    name: "koi:approval-routing",
    priority: APPROVAL_ROUTING_PRIORITY,

    attach: async (agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const id = agent.pid.id;
      const parentId = agent.pid.parent;
      const mailbox = agent.component<MailboxComponent>(MAILBOX);
      const localDisposables: Disposable[] = [];

      if (mailbox !== undefined) {
        // Child-side: if this agent has a parent, route approvals to it
        if (parentId !== undefined) {
          agentHandlers.set(
            id as string,
            createAgentApprovalHandler({
              parentId,
              childAgentId: id,
              mailbox,
              timeoutMs: execApprovals.approvalTimeoutMs,
              fallback: userOnAsk, // user's original onAsk (HITL) as fallback
            }),
          );
        }

        // Parent-side: listen for child approval requests
        const parentHandler = createParentApprovalHandler({
          agentId: id,
          mailbox,
          rules: execApprovals.rules,
          extractCommand: execApprovals.extractCommand,
          onAsk: userOnAsk,
        });
        localDisposables.push(parentHandler);
        disposables.push(parentHandler);
      }

      agentDisposables.set(id as string, localDisposables);
      return new Map();
    },

    detach: async (agent: Agent): Promise<void> => {
      const id = agent.pid.id as string;
      // Clean up per-agent handlers
      agentHandlers.delete(id);
      // Dispose per-agent subscriptions
      const entries = agentDisposables.get(id);
      if (entries !== undefined) {
        for (const d of entries) {
          d[Symbol.dispose]();
        }
        agentDisposables.delete(id);
      }
    },
  };

  return { provider, effectiveConfig };
}

// ---------------------------------------------------------------------------
// Capability verifier auto-wiring
// ---------------------------------------------------------------------------

interface AutoWireResult {
  readonly delegation: DelegationMiddlewareConfig | undefined;
  readonly sessionStore: SessionRevocationStore | undefined;
}

/**
 * When delegation is configured without an explicit verifier, auto-creates
 * a composite capability verifier backed by a session revocation store.
 *
 * This enables HMAC + Ed25519 verification, session-scoped revocation,
 * and resource pattern matching by default for all governance presets.
 * Callers can opt out by providing their own `verifier` in the delegation config.
 */
function autoWireVerifier(delegation: DelegationMiddlewareConfig | undefined): AutoWireResult {
  if (delegation === undefined || delegation.verifier !== undefined) {
    return { delegation, sessionStore: undefined };
  }
  const store = createSessionRevocationStore();
  const verifier = createCapabilityVerifier({
    hmacSecret: delegation.secret,
    scopeChecker: defaultScopeChecker,
  });
  return {
    delegation: {
      ...delegation,
      verifier,
      activeSessionIds: (): ReadonlySet<SessionId> => store.snapshot(),
    },
    sessionStore: store,
  };
}

// ---------------------------------------------------------------------------
// Audit backend auto-wiring
// ---------------------------------------------------------------------------

interface AuditSinkResult {
  readonly sink: AuditSink;
  /** Optional close disposable (for SQLite/NDJSON cleanup). */
  readonly close?: (() => void) | undefined;
}

/** Create an AuditSink from a declarative AuditBackendConfig. */
function createAuditSinkFromConfig(config: AuditBackendConfig): AuditSinkResult {
  switch (config.kind) {
    case "sqlite": {
      const { kind: _, ...sinkConfig } = config;
      const sink = createSqliteAuditSink(sinkConfig);
      return { sink, close: sink.close };
    }
    case "ndjson": {
      const { kind: _, ...sinkConfig } = config;
      const sink = createNdjsonAuditSink(sinkConfig);
      return { sink, close: sink.close };
    }
    case "nexus": {
      const { kind: _, ...sinkConfig } = config;
      return { sink: createNexusAuditSink(sinkConfig) };
    }
    case "custom":
      return { sink: config.sink };
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unknown audit backend kind: ${(_exhaustive as AuditBackendConfig).kind}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Anomaly collector (glue between agent-monitor and security-analyzer)
// ---------------------------------------------------------------------------

interface AnomalyCollector {
  readonly getRecentAnomalies: (sessionId: string) => readonly AnomalySignalLike[];
  readonly onAnomaly: (signal: AnomalySignalLike) => void;
  readonly clearSession: (sessionId: string) => void;
}

const MAX_ANOMALIES_PER_SESSION = 50;

function createAnomalyCollector(): AnomalyCollector {
  const buffers = new Map<string, readonly AnomalySignalLike[]>();
  return {
    getRecentAnomalies: (sessionId) => buffers.get(sessionId) ?? [],
    onAnomaly: (signal) => {
      const buf = buffers.get(signal.sessionId) ?? [];
      buffers.set(
        signal.sessionId,
        buf.length < MAX_ANOMALIES_PER_SESSION
          ? [...buf, { kind: signal.kind, sessionId: signal.sessionId }]
          : [...buf.slice(1), { kind: signal.kind, sessionId: signal.sessionId }],
      );
    },
    clearSession: (sessionId) => {
      buffers.delete(sessionId);
    },
  };
}

// ---------------------------------------------------------------------------
// Security analyzer auto-wiring
// ---------------------------------------------------------------------------

interface SecurityAnalyzerWireResult {
  readonly effectiveExecApprovals: ExecApprovalsConfig;
  readonly collector: AnomalyCollector | undefined;
}

/**
 * Conditionally compose rules analyzer + monitor bridge and inject into exec-approvals.
 *
 * Skip conditions:
 * 1. execApprovals is undefined
 * 2. execApprovals.securityAnalyzer is already set (user wins)
 * 3. Neither agentMonitor nor securityAnalyzer config is present
 */
function autoWireSecurityAnalyzer(resolved: GovernanceStackConfig): SecurityAnalyzerWireResult {
  const ea = resolved.execApprovals;

  // Skip if no exec-approvals to inject into
  if (ea === undefined) {
    return { effectiveExecApprovals: ea as never, collector: undefined };
  }

  // Skip if user already provided a securityAnalyzer (user wins)
  if (ea.securityAnalyzer !== undefined) {
    return { effectiveExecApprovals: ea, collector: undefined };
  }

  const monitorCfg = resolved.agentMonitor;
  const analyzerCfg = resolved.securityAnalyzer;

  // Skip if neither pipeline component is configured
  if (monitorCfg === undefined && analyzerCfg === undefined) {
    return { effectiveExecApprovals: ea, collector: undefined };
  }

  // Create rules analyzer from securityAnalyzer config (if any)
  const rulesAnalyzer = createRulesSecurityAnalyzer(
    analyzerCfg !== undefined
      ? {
          ...(analyzerCfg.highPatterns !== undefined
            ? { highPatterns: analyzerCfg.highPatterns }
            : {}),
          ...(analyzerCfg.mediumPatterns !== undefined
            ? { mediumPatterns: analyzerCfg.mediumPatterns }
            : {}),
        }
      : {},
  );

  // If agentMonitor is configured, wrap with monitor bridge
  if (monitorCfg !== undefined) {
    const collector = createAnomalyCollector();
    const bridged = createMonitorBridgeAnalyzer({
      wrapped: rulesAnalyzer,
      getRecentAnomalies: collector.getRecentAnomalies,
      ...(analyzerCfg?.elevateOnAnomalyKinds !== undefined
        ? { elevateOnAnomalyKinds: analyzerCfg.elevateOnAnomalyKinds }
        : {}),
    });
    return {
      effectiveExecApprovals: {
        ...ea,
        securityAnalyzer: bridged,
        ...(analyzerCfg?.analyzerTimeoutMs !== undefined
          ? { analyzerTimeoutMs: analyzerCfg.analyzerTimeoutMs }
          : {}),
      },
      collector,
    };
  }

  // No agentMonitor → rules analyzer only (no bridge)
  return {
    effectiveExecApprovals: {
      ...ea,
      securityAnalyzer: rulesAnalyzer,
      ...(analyzerCfg?.analyzerTimeoutMs !== undefined
        ? { analyzerTimeoutMs: analyzerCfg.analyzerTimeoutMs }
        : {}),
    },
    collector: undefined,
  };
}

// ---------------------------------------------------------------------------
// Agent-monitor config builder (chains governance callbacks with user callbacks)
// ---------------------------------------------------------------------------

function buildAgentMonitorConfig(
  config: AgentMonitorConfig,
  collector: AnomalyCollector | undefined,
): AgentMonitorConfig {
  if (collector === undefined) return config;

  const userOnAnomaly = config.onAnomaly;
  const userOnMetrics = config.onMetrics;

  return {
    ...config,
    onAnomaly: (signal: AnomalySignal): void => {
      collector.onAnomaly(signal);
      if (userOnAnomaly !== undefined) userOnAnomaly(signal);
    },
    onMetrics: (sessionId: SessionId, summary: SessionMetricsSummary): void => {
      collector.clearSession(sessionId as string);
      if (userOnMetrics !== undefined) userOnMetrics(sessionId, summary);
    },
  };
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

/**
 * Assemble a governance compliance middleware stack.
 *
 * Returns a `GovernanceBundle` with `middlewares`, `providers`, and `config` metadata.
 * Pass `middlewares` and `providers` directly to createKoi():
 *
 * ```typescript
 * const { middlewares, providers } = createGovernanceStack({ preset: "standard" });
 * const runtime = await createKoi({ ..., middleware: middlewares, providers });
 * ```
 *
 * Config resolution: defaults -> preset -> user overrides.
 * Agent approval routing is auto-wired via ComponentProvider during assembly.
 * When exec-approvals is configured, the provider auto-discovers agentId, parentId,
 * and mailbox from the agent entity — zero explicit config needed.
 */
export function createGovernanceStack(config: GovernanceStackConfig): GovernanceBundle {
  // Validate: auditBackend and audit.sink are mutually exclusive
  if (config.auditBackend !== undefined && config.audit?.sink !== undefined) {
    throw new Error(
      "GovernanceStack: 'auditBackend' and 'audit.sink' are mutually exclusive. " +
        "Use 'auditBackend' for declarative backend selection, or provide 'audit.sink' directly.",
    );
  }

  // Auto-create audit sink from declarative config
  const auditSinkResult =
    config.auditBackend !== undefined ? createAuditSinkFromConfig(config.auditBackend) : undefined;

  // If auditBackend is provided, merge the sink into the config before resolution
  const effectiveConfig =
    auditSinkResult !== undefined
      ? {
          ...config,
          audit: { ...config.audit, sink: auditSinkResult.sink },
          backends: { ...config.backends, auditSink: auditSinkResult.sink },
        }
      : config;

  const resolved = resolveGovernanceConfig(effectiveConfig);

  // Validate: capabilityRequest requires delegationBridge
  if (config.capabilityRequest !== undefined && config.delegationBridge === undefined) {
    throw new Error(
      "GovernanceStack: 'capabilityRequest' requires 'delegationBridge' to also be configured. " +
        "Add a delegationBridge with a DelegationManager to enable pull-model capability requests.",
    );
  }

  // Wire Nexus delegation hooks when nexusBackend is provided.
  // These are exposed on the bundle for the caller to attach to a new DelegationManager,
  // or validated when the manager is already pre-wired.
  const nexusHooks =
    config.delegationBridge?.nexusBackend !== undefined
      ? {
          onGrant: createNexusOnGrant(config.delegationBridge.nexusBackend),
          onRevoke: createNexusOnRevoke(
            config.delegationBridge.nexusBackend,
            (grantId: DelegationId) => {
              const grants = config.delegationBridge?.manager.list();
              return grants?.find((g) => g.id === grantId);
            },
          ),
        }
      : undefined;

  // Create capability request bridge when both delegationBridge and capabilityRequest are configured
  const capabilityRequestBridge =
    config.delegationBridge !== undefined && config.capabilityRequest !== undefined
      ? createCapabilityRequestBridge({
          manager: config.delegationBridge.manager,
          approvalTimeoutMs: config.capabilityRequest.approvalTimeoutMs,
          maxForwardDepth: config.capabilityRequest.maxForwardDepth,
        })
      : undefined;

  // ── Auto-wire security analyzer pipeline ─────────────────────────────
  // agent-monitor → security-analyzer → exec-approvals
  const { effectiveExecApprovals, collector } = autoWireSecurityAnalyzer(resolved);

  // ── Agent approval routing auto-wiring ────────────────────────────────
  // When exec-approvals is configured, create a ComponentProvider that auto-discovers
  // agentId (pid.id), parentId (pid.parent), and mailbox (MAILBOX component) during
  // agent assembly. Zero explicit config needed — routing is wired dynamically.
  const disposables: Disposable[] = [];

  // Track audit sink close for cleanup (SQLite/NDJSON file handles)
  if (auditSinkResult?.close !== undefined) {
    const closeFn = auditSinkResult.close;
    disposables.push({ [Symbol.dispose]: closeFn });
  }

  const approvalRouting =
    resolved.execApprovals !== undefined
      ? createApprovalRoutingProvider(effectiveExecApprovals, disposables)
      : undefined;

  // Auto-wire capability verifier when delegation is configured without explicit verifier
  const preset = resolved.preset ?? "open";
  const { delegation: effectiveDelegation, sessionStore } = autoWireVerifier(resolved.delegation);

  // Wire delegation-escalation when configured (returns a handle, extract .middleware)
  const delegationEscalationHandle =
    config.delegationEscalation !== undefined
      ? createDelegationEscalationMiddleware(config.delegationEscalation)
      : undefined;

  // Build effective agent-monitor config with chained callbacks
  const effectiveAgentMonitor =
    resolved.agentMonitor !== undefined
      ? buildAgentMonitorConfig(resolved.agentMonitor, collector)
      : undefined;

  const candidates: ReadonlyArray<KoiMiddleware | undefined> = [
    resolved.permissions !== undefined
      ? createPermissionsMiddleware(resolved.permissions) // 100
      : undefined,
    approvalRouting !== undefined
      ? { ...createExecApprovalsMiddleware(approvalRouting.effectiveConfig), priority: 110 }
      : undefined,
    effectiveDelegation !== undefined
      ? { ...createDelegationMiddleware(effectiveDelegation), priority: 120 } // override
      : undefined,
    capabilityRequestBridge?.middleware, // 125
    delegationEscalationHandle !== undefined
      ? { ...delegationEscalationHandle.middleware, priority: 130 } // override from 300
      : undefined,
    resolved.governanceBackend !== undefined
      ? createGovernanceBackendMiddleware(resolved.governanceBackend) // 150
      : undefined,
    resolved.pay !== undefined
      ? createPayMiddleware(
          // Auto-inject agentDepth into pay.agentBudget when both are configured
          resolved.pay.agentBudget !== undefined && config.agentDepth !== undefined
            ? {
                ...resolved.pay,
                agentBudget: { ...resolved.pay.agentBudget, agentDepth: config.agentDepth },
              }
            : resolved.pay,
        ) // 200
      : undefined,
    config.intentCapsule !== undefined
      ? createIntentCapsuleMiddleware(config.intentCapsule) // 290
      : undefined,
    resolved.audit !== undefined
      ? createAuditMiddleware(resolved.audit) // 300
      : undefined,
    resolved.pii !== undefined
      ? createPIIMiddleware(resolved.pii) // 340
      : undefined,
    // Note: redaction (345) is not a middleware — it's a standalone Redactor exposed on the bundle.
    resolved.sanitize !== undefined
      ? createSanitizeMiddleware(resolved.sanitize) // 350
      : undefined,
    effectiveAgentMonitor !== undefined
      ? { ...createAgentMonitorMiddleware(effectiveAgentMonitor), priority: 360 } // 360
      : undefined,
    resolved.guardrails !== undefined
      ? createGuardrailsMiddleware(resolved.guardrails) // 375
      : undefined,
  ];

  const middlewares = candidates.filter((mw): mw is KoiMiddleware => mw !== undefined);

  // Wire scope providers when scope + backends are present
  const scopeProviders =
    resolved.scope !== undefined && resolved.backends !== undefined
      ? wireGovernanceScope(resolved.scope, resolved.backends, resolved.enforcer)
      : [];

  // Wire delegation provider when delegationBridge is configured.
  // Decision #1-A: nexusDelegation → NexusDelegationProvider (Nexus backend),
  //                absent → createDelegationProvider (in-memory backend).
  const delegationProviders =
    config.delegationBridge !== undefined
      ? config.delegationBridge.nexusDelegation !== undefined
        ? [
            createNexusDelegationProvider({
              api: createNexusDelegationApi(
                createNexusRestClient({
                  baseUrl: config.delegationBridge.nexusDelegation.nexusUrl,
                  authToken: config.delegationBridge.nexusDelegation.nexusApiKey,
                }),
              ),
              nexusApiKey: config.delegationBridge.nexusDelegation.nexusApiKey,
              enabled: true,
            }),
          ]
        : [
            createDelegationProvider({
              manager: config.delegationBridge.manager,
              enabled: true,
              ...(config.delegationBridge.permissionBackend !== undefined
                ? { permissionBackend: config.delegationBridge.permissionBackend }
                : {}),
            }),
          ]
      : [];

  const capabilityRequestProviders =
    capabilityRequestBridge !== undefined ? [capabilityRequestBridge.provider] : [];

  const approvalRoutingProviders = approvalRouting !== undefined ? [approvalRouting.provider] : [];
  const providers = [
    ...scopeProviders,
    ...delegationProviders,
    ...capabilityRequestProviders,
    ...approvalRoutingProviders,
  ];

  // Create redactor when redaction config is provided
  const redactor =
    resolved.redaction !== undefined ? createRedactor(resolved.redaction) : undefined;

  return {
    middlewares,
    providers,
    disposables,
    config: {
      preset,
      middlewareCount: middlewares.length,
      providerCount: providers.length,
      scopeEnabled: resolved.scope !== undefined,
    },
    ...(nexusHooks !== undefined ? { nexusHooks } : {}),
    ...(sessionStore !== undefined ? { sessionStore } : {}),
    ...(delegationEscalationHandle !== undefined ? { delegationEscalationHandle } : {}),
    ...(redactor !== undefined ? { redactor } : {}),
    ...(collector !== undefined
      ? {
          anomalyCollector: {
            getRecentAnomalies: collector.getRecentAnomalies,
            clearSession: collector.clearSession,
          },
        }
      : {}),
  };
}
