/**
 * createGovernanceStack — enterprise compliance middleware assembly.
 *
 * Composes up to 11 middleware into a single stack with a fixed priority order.
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
 *   375  koi:guardrails
 */

import type { SessionRevocationStore } from "@koi/capability-verifier";
import { createCapabilityVerifier, createSessionRevocationStore } from "@koi/capability-verifier";
import type {
  Agent,
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

import { resolveGovernanceConfig } from "./config-resolution.js";
import { wireGovernanceScope } from "./scope-wiring.js";
import type { GovernanceBundle, GovernanceStackConfig } from "./types.js";

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
    // In 1:1 model, the map has one entry. Use the first handler found.
    // This is safe: the governance stack is created per-agent in Koi's architecture.
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
  const resolved = resolveGovernanceConfig(config);

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

  // ── Agent approval routing auto-wiring ────────────────────────────────
  // When exec-approvals is configured, create a ComponentProvider that auto-discovers
  // agentId (pid.id), parentId (pid.parent), and mailbox (MAILBOX component) during
  // agent assembly. Zero explicit config needed — routing is wired dynamically.
  const disposables: Disposable[] = [];
  const approvalRouting =
    resolved.execApprovals !== undefined
      ? createApprovalRoutingProvider(resolved.execApprovals, disposables)
      : undefined;

  // Auto-wire capability verifier when delegation is configured without explicit verifier
  const preset = resolved.preset ?? "open";
  const { delegation: effectiveDelegation, sessionStore } = autoWireVerifier(resolved.delegation);

  // Wire delegation-escalation when configured (returns a handle, extract .middleware)
  const delegationEscalationHandle =
    config.delegationEscalation !== undefined
      ? createDelegationEscalationMiddleware(config.delegationEscalation)
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
      ? createPayMiddleware(resolved.pay) // 200
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
    resolved.sanitize !== undefined
      ? createSanitizeMiddleware(resolved.sanitize) // 350
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

  // Wire delegation provider when delegationBridge is configured
  const delegationProviders =
    config.delegationBridge !== undefined
      ? [
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
  };
}
