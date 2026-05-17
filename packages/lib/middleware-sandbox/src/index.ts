import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ToolHandler,
  ToolPolicy,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";

export interface SandboxEnforcementWarning {
  readonly kind: "model-context" | "tool-call";
  readonly toolId: string;
  readonly reason: "sandbox_required_without_executor";
}

export interface SandboxEnforcementConfig {
  readonly required?: boolean | undefined;
  readonly sandboxBackedTools?: readonly string[] | undefined;
  readonly isSandboxBacked?: ((toolId: string) => boolean) | undefined;
  /**
   * Provider-backed tools are only trusted when the host explicitly attests
   * that the concrete attached policy comes from a provider that enforces an
   * equivalent boundary. The policy parameter lets hosts bind trust to the
   * actual component, not just a spoofable tool name.
   */
  readonly isProviderSandboxBacked?: ((toolId: string, policy: ToolPolicy) => boolean) | undefined;
  /**
   * @deprecated Use sandboxBackedTools/isSandboxBacked so enforcement is scoped
   * to the exact tools that actually route through the sandbox executor.
   */
  readonly executorConfigured?: boolean | undefined;
  readonly policies?: Readonly<Record<string, ToolPolicy>> | undefined;
  readonly policyFor?: ((toolId: string) => ToolPolicy | undefined) | undefined;
  readonly onWarning?: ((warning: SandboxEnforcementWarning) => void) | undefined;
}

interface SandboxEnforcementState {
  readonly required: boolean;
  readonly isSandboxBacked: (toolId: string) => boolean;
  readonly isProviderSandboxBacked: (toolId: string, policy: ToolPolicy) => boolean;
  readonly policies: Readonly<Record<string, ToolPolicy>>;
  readonly policyFor: (toolId: string) => ToolPolicy | undefined;
  readonly onWarning: ((warning: SandboxEnforcementWarning) => void) | undefined;
  readonly capability: CapabilityFragment;
}

function createPolicyResolver(
  policies: Readonly<Record<string, ToolPolicy>>,
  policyFor: ((toolId: string) => ToolPolicy | undefined) | undefined,
): (toolId: string) => ToolPolicy | undefined {
  return (toolId) => policyFor?.(toolId) ?? policies[toolId];
}

function shouldEnforce(state: SandboxEnforcementState, toolId: string): boolean {
  const policy = state.policyFor(toolId);
  if (policy?.sandbox !== true) return false;
  if (policy.sandboxBacking === "provider") return !state.isProviderSandboxBacked(toolId, policy);
  return !state.isSandboxBacked(toolId);
}

function warn(state: SandboxEnforcementState, warning: SandboxEnforcementWarning): void {
  try {
    state.onWarning?.(warning);
  } catch {
    // Observer hooks must not affect enforcement.
  }
}

function filterTools(state: SandboxEnforcementState, request: ModelRequest): ModelRequest {
  if (!state.required || request.tools === undefined) return request;
  const tools = request.tools.filter((tool) => {
    if (!shouldEnforce(state, tool.name)) return true;
    warn(state, {
      kind: "model-context",
      toolId: tool.name,
      reason: "sandbox_required_without_executor",
    });
    return false;
  });
  return tools.length === request.tools.length ? request : { ...request, tools };
}

async function wrapModelCall(
  state: SandboxEnforcementState,
  _ctx: TurnContext,
  request: ModelRequest,
  next: ModelHandler,
): Promise<ModelResponse> {
  return next(filterTools(state, request));
}

function wrapModelStream(
  state: SandboxEnforcementState,
  _ctx: TurnContext,
  request: ModelRequest,
  next: ModelStreamHandler,
): AsyncIterable<ModelChunk> {
  return next(filterTools(state, request));
}

async function wrapToolCall(
  state: SandboxEnforcementState,
  _ctx: TurnContext,
  request: ToolRequest,
  next: ToolHandler,
): Promise<ToolResponse> {
  if (!shouldEnforce(state, request.toolId)) return next(request);
  if (!state.required) {
    warn(state, {
      kind: "tool-call",
      toolId: request.toolId,
      reason: "sandbox_required_without_executor",
    });
    return next(request);
  }
  throw KoiRuntimeError.from(
    "PERMISSION",
    `Tool '${request.toolId}' requires sandboxed execution, but no sandbox executor is configured`,
    {
      retryable: false,
      context: {
        toolId: request.toolId,
        reason: "sandbox_required_without_executor",
      },
    },
  );
}

export function createSandboxEnforcementMiddleware(
  config: SandboxEnforcementConfig,
): KoiMiddleware {
  const policies = config.policies ?? {};
  const sandboxBackedTools = new Set(config.sandboxBackedTools ?? []);
  const isSandboxBacked =
    config.isSandboxBacked ?? ((toolId: string) => sandboxBackedTools.has(toolId));
  const isProviderSandboxBacked = config.isProviderSandboxBacked ?? (() => false);
  const state: SandboxEnforcementState = {
    required: config.required ?? false,
    isSandboxBacked,
    isProviderSandboxBacked,
    policies,
    policyFor: createPolicyResolver(policies, config.policyFor),
    onWarning: config.onWarning,
    capability: {
      label: "sandbox-enforcement",
      description:
        sandboxBackedTools.size > 0 || config.isSandboxBacked !== undefined
          ? "Sandbox-required tools have an executor configured"
          : config.required === true
            ? "Sandbox-required tools fail closed when no executor is configured"
            : "Sandbox-required tools warn when no executor is configured",
    },
  };

  return {
    name: "koi:sandbox-enforcement",
    priority: 90,
    phase: "intercept",
    wrapModelCall: (ctx, request, next) => wrapModelCall(state, ctx, request, next),
    wrapModelStream: (ctx, request, next) => wrapModelStream(state, ctx, request, next),
    wrapToolCall: (ctx, request, next) => wrapToolCall(state, ctx, request, next),
    describeCapabilities: () => state.capability,
  } satisfies KoiMiddleware;
}
