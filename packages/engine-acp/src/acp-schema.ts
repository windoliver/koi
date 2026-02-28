/**
 * Zod schemas for ACP (Agent Client Protocol) wire types.
 *
 * All Zod schema consts are module-private (compatible with isolatedDeclarations).
 * All exported TypeScript types are declared explicitly — never via z.infer<typeof Schema>.
 * Only TypeScript types and parse functions are exported.
 *
 * This isolates all ACP spec definitions in one place — when the protocol
 * changes, only this file needs updating.
 *
 * Based on ACP v0.10.x (JSON-RPC 2.0 over stdin/stdout).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 base
// ---------------------------------------------------------------------------

export type RpcId = string | number | null;

export interface RpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * Loose type for any incoming JSON-RPC message. Used to discriminate
 * between request, notification, success response, and error response.
 */
export interface AnyRpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null | undefined;
  readonly method?: string | undefined;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: RpcErrorObject | undefined;
}

const RpcIdSchema = z.union([z.string(), z.number(), z.null()]);

const RpcErrorObjectSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

const AnyRpcMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcIdSchema.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: RpcErrorObjectSchema.optional(),
});

/** Parse any incoming ACP message. Returns undefined if invalid. */
export function parseAnyRpcMessage(value: unknown): AnyRpcMessage | undefined {
  const r = AnyRpcMessageSchema.safeParse(value);
  return r.success ? r.data : undefined;
}

// ---------------------------------------------------------------------------
// Content blocks (ACP typed content)
// ---------------------------------------------------------------------------

export interface TextContent {
  readonly type: "text";
  readonly text: string;
  readonly mimeType?: "text/plain" | "text/markdown" | undefined;
}

export interface ImageContent {
  readonly type: "image";
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly data: string; // base64
}

interface ResourceLinkContent {
  readonly type: "resourceLink";
  readonly uri: string;
  readonly mimeType: string;
}

interface EmbeddedResourceContent {
  readonly type: "resource";
  readonly uri: string;
  readonly mimeType: string;
  readonly text?: string | undefined;
  readonly blob?: string | undefined;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | ResourceLinkContent
  | EmbeddedResourceContent;

const TextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  mimeType: z.enum(["text/plain", "text/markdown"]).optional(),
});

const ImageContentSchema = z.object({
  type: z.literal("image"),
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z.string(),
});

const ResourceLinkSchema = z.object({
  type: z.literal("resourceLink"),
  uri: z.string(),
  mimeType: z.string(),
});

const EmbeddedResourceSchema = z.object({
  type: z.literal("resource"),
  uri: z.string(),
  mimeType: z.string(),
  text: z.string().optional(),
  blob: z.string().optional(),
});

const ContentBlockSchema = z.discriminatedUnion("type", [
  TextContentSchema,
  ImageContentSchema,
  ResourceLinkSchema,
  EmbeddedResourceSchema,
]);

// ---------------------------------------------------------------------------
// Tool call shapes (used in session/update and session/request_permission)
// ---------------------------------------------------------------------------

export type ToolCallKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

interface ToolCallLocation {
  readonly path: string;
  readonly lineStart?: number | undefined;
  readonly lineEnd?: number | undefined;
}

export interface ToolCall {
  readonly toolCallId: string;
  readonly title: string;
  readonly kind: ToolCallKind;
  readonly status: ToolCallStatus;
  readonly content?: readonly ContentBlock[] | undefined;
  readonly locations?: readonly ToolCallLocation[] | undefined;
  readonly rawInput?: Readonly<Record<string, unknown>> | undefined;
  readonly rawOutput?: Readonly<Record<string, unknown>> | undefined;
}

const ToolCallKindSchema = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "other",
]);

const ToolCallStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);

const ToolCallLocationSchema = z.object({
  path: z.string(),
  lineStart: z.number().optional(),
  lineEnd: z.number().optional(),
});

const ToolCallSchema = z.object({
  toolCallId: z.string(),
  title: z.string(),
  kind: ToolCallKindSchema,
  status: ToolCallStatusSchema,
  content: z.array(ContentBlockSchema).optional(),
  locations: z.array(ToolCallLocationSchema).optional(),
  rawInput: z.record(z.string(), z.unknown()).optional(),
  rawOutput: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Capability schemas
// ---------------------------------------------------------------------------

export interface ClientCapabilities {
  readonly fs?:
    | {
        readonly readTextFile?: boolean | undefined;
        readonly writeTextFile?: boolean | undefined;
      }
    | undefined;
  readonly terminal?: boolean | undefined;
}

export interface AgentCapabilities {
  readonly loadSession?: boolean | undefined;
  readonly promptCapabilities?:
    | {
        readonly image?: boolean | undefined;
        readonly audio?: boolean | undefined;
        readonly embeddedContext?: boolean | undefined;
      }
    | undefined;
  readonly mcp?:
    | {
        readonly http?: boolean | undefined;
        readonly sse?: boolean | undefined;
      }
    | undefined;
}

const ClientCapabilitiesSchema = z
  .object({
    fs: z
      .object({
        readTextFile: z.boolean().optional(),
        writeTextFile: z.boolean().optional(),
      })
      .optional(),
    terminal: z.boolean().optional(),
  })
  .passthrough();

const AgentCapabilitiesSchema = z
  .object({
    loadSession: z.boolean().optional(),
    promptCapabilities: z
      .object({
        image: z.boolean().optional(),
        audio: z.boolean().optional(),
        embeddedContext: z.boolean().optional(),
      })
      .optional(),
    mcp: z
      .object({
        http: z.boolean().optional(),
        sse: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface InitializeParams {
  readonly protocolVersion: number;
  readonly clientInfo?:
    | {
        readonly name?: string | undefined;
        readonly title?: string | undefined;
        readonly version?: string | undefined;
      }
    | undefined;
  readonly clientCapabilities?: ClientCapabilities | undefined;
}

export interface InitializeResult {
  readonly protocolVersion: number;
  readonly agentInfo?:
    | {
        readonly name?: string | undefined;
        readonly title?: string | undefined;
        readonly version?: string | undefined;
      }
    | undefined;
  readonly agentCapabilities?: AgentCapabilities | undefined;
}

const _InitializeParamsSchema = z.object({
  protocolVersion: z.number(),
  clientInfo: z
    .object({
      name: z.string().optional(),
      title: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
  clientCapabilities: ClientCapabilitiesSchema.optional(),
});

const InitializeResultSchema = z
  .object({
    protocolVersion: z.number(),
    agentInfo: z
      .object({
        name: z.string().optional(),
        title: z.string().optional(),
        version: z.string().optional(),
      })
      .optional(),
    agentCapabilities: AgentCapabilitiesSchema.optional(),
  })
  .passthrough();

/** Parse an initialize result. Returns undefined if invalid. */
export function parseInitializeResult(value: unknown): InitializeResult | undefined {
  const r = InitializeResultSchema.safeParse(value);
  return r.success ? r.data : undefined;
}

// ---------------------------------------------------------------------------
// session/new
// ---------------------------------------------------------------------------

interface McpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly env?: readonly { readonly name: string; readonly value: string }[] | undefined;
}

export interface SessionNewParams {
  readonly cwd: string;
  readonly mcpServers?: readonly McpServerConfig[] | undefined;
}

export interface SessionNewResult {
  readonly sessionId: string;
}

const McpServerConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
});

const _SessionNewParamsSchema = z.object({
  cwd: z.string(),
  mcpServers: z.array(McpServerConfigSchema).optional(),
});

const SessionNewResultSchema = z.object({
  sessionId: z.string(),
});

/** Parse a session/new result. Returns undefined if invalid. */
export function parseSessionNewResult(value: unknown): SessionNewResult | undefined {
  const r = SessionNewResultSchema.safeParse(value);
  return r.success ? r.data : undefined;
}

// ---------------------------------------------------------------------------
// session/prompt
// ---------------------------------------------------------------------------

export interface SessionPromptParams {
  readonly sessionId: string;
  readonly prompt: readonly ContentBlock[];
}

export interface SessionPromptResult {
  readonly stopReason: "end_turn" | "tool_call" | "error" | "cancelled" | "max_iterations";
  readonly usage?:
    | {
        readonly inputTokens?: number | undefined;
        readonly outputTokens?: number | undefined;
      }
    | undefined;
}

const _SessionPromptParamsSchema = z.object({
  sessionId: z.string(),
  prompt: z.array(ContentBlockSchema),
});

const SessionPromptResultSchema = z.object({
  stopReason: z.enum(["end_turn", "tool_call", "error", "cancelled", "max_iterations"]),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    })
    .optional(),
});

/** Parse a session/prompt result. Returns undefined if invalid. */
export function parseSessionPromptResult(value: unknown): SessionPromptResult | undefined {
  const r = SessionPromptResultSchema.safeParse(value);
  return r.success ? r.data : undefined;
}

// ---------------------------------------------------------------------------
// session/update (notification: Agent → Koi)
// ---------------------------------------------------------------------------

interface AgentMessageChunkUpdate {
  readonly sessionUpdate: "agent_message_chunk";
  readonly content: readonly ContentBlock[];
}

interface AgentThoughtChunkUpdate {
  readonly sessionUpdate: "agent_thought_chunk";
  readonly content: { readonly type: "text"; readonly text: string };
}

interface ToolCallUpdate {
  readonly sessionUpdate: "tool_call";
  readonly toolCallId: string;
  readonly title: string;
  readonly kind: ToolCallKind;
  readonly status: ToolCallStatus;
  readonly content?: readonly ContentBlock[] | undefined;
  readonly locations?: readonly ToolCallLocation[] | undefined;
  readonly rawInput?: Readonly<Record<string, unknown>> | undefined;
  readonly rawOutput?: Readonly<Record<string, unknown>> | undefined;
}

interface ToolCallUpdateNotif {
  readonly sessionUpdate: "tool_call_update";
  readonly toolCallId: string;
  readonly status?: ToolCallStatus | undefined;
  readonly content?: readonly ContentBlock[] | undefined;
}

interface PlanUpdate {
  readonly sessionUpdate: "plan";
  readonly content: readonly ContentBlock[];
}

interface CurrentModeUpdate {
  readonly sessionUpdate: "current_mode_update";
  readonly mode: string;
}

export type SessionUpdatePayload =
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | ToolCallUpdate
  | ToolCallUpdateNotif
  | PlanUpdate
  | CurrentModeUpdate;

export interface SessionUpdateParams {
  readonly sessionId: string;
  readonly update: SessionUpdatePayload;
}

const AgentMessageChunkUpdateSchema = z.object({
  sessionUpdate: z.literal("agent_message_chunk"),
  // ACP spec defines content as an array of blocks, but some agents (e.g.,
  // codex-acp 0.9.x) send a single content block object instead of a
  // single-element array. Normalize via preprocess so both forms are accepted.
  content: z.preprocess((c) => (Array.isArray(c) ? c : [c]), z.array(ContentBlockSchema)),
});

const AgentThoughtChunkUpdateSchema = z.object({
  sessionUpdate: z.literal("agent_thought_chunk"),
  content: z.object({ type: z.literal("text"), text: z.string() }),
});

const ToolCallUpdateSchema = z.object({
  sessionUpdate: z.literal("tool_call"),
  toolCallId: z.string(),
  title: z.string(),
  kind: ToolCallKindSchema,
  status: ToolCallStatusSchema,
  content: z.array(ContentBlockSchema).optional(),
  locations: z.array(ToolCallLocationSchema).optional(),
  rawInput: z.record(z.string(), z.unknown()).optional(),
  rawOutput: z.record(z.string(), z.unknown()).optional(),
});

const ToolCallUpdateNotifSchema = z.object({
  sessionUpdate: z.literal("tool_call_update"),
  toolCallId: z.string(),
  status: ToolCallStatusSchema.optional(),
  content: z.array(ContentBlockSchema).optional(),
});

const PlanUpdateSchema = z.object({
  sessionUpdate: z.literal("plan"),
  content: z.array(ContentBlockSchema),
});

const CurrentModeUpdateSchema = z.object({
  sessionUpdate: z.literal("current_mode_update"),
  mode: z.string(),
});

const SessionUpdatePayloadSchema = z.discriminatedUnion("sessionUpdate", [
  AgentMessageChunkUpdateSchema,
  AgentThoughtChunkUpdateSchema,
  ToolCallUpdateSchema,
  ToolCallUpdateNotifSchema,
  PlanUpdateSchema,
  CurrentModeUpdateSchema,
]);

const SessionUpdateParamsSchema = z.object({
  sessionId: z.string(),
  update: SessionUpdatePayloadSchema,
});

/** Parse a session/update notification params. Returns undefined if invalid. */
export function parseSessionUpdateParams(value: unknown): SessionUpdateParams | undefined {
  const r = SessionUpdateParamsSchema.safeParse(value);
  if (r.success) return r.data;

  // If the sessionUpdate kind itself is unrecognised (agent-specific extension),
  // return undefined silently — the caller should skip, not warn.
  const update =
    typeof value === "object" && value !== null
      ? ((value as Record<string, unknown>).update as Record<string, unknown> | undefined)
      : undefined;
  if (typeof update?.sessionUpdate === "string") return undefined;

  // Genuine schema error on a known kind — caller will warn.
  return undefined;
}

// ---------------------------------------------------------------------------
// session/request_permission (Agent → Koi, expects response)
// ---------------------------------------------------------------------------

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface SessionRequestPermissionParams {
  readonly sessionId: string;
  readonly toolCall: ToolCall;
  readonly options?: readonly PermissionOption[] | undefined;
}

export type PermissionOutcome =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };

const PermissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
});

const SessionRequestPermissionParamsSchema = z.object({
  sessionId: z.string(),
  toolCall: ToolCallSchema,
  options: z.array(PermissionOptionSchema).optional(),
});

/** Parse session/request_permission params. Returns undefined if invalid. */
export function parseSessionRequestPermissionParams(
  value: unknown,
): SessionRequestPermissionParams | undefined {
  const r = SessionRequestPermissionParamsSchema.safeParse(value);
  return r.success ? r.data : undefined;
}

// ---------------------------------------------------------------------------
// fs/* (Agent → Koi, expects response)
// ---------------------------------------------------------------------------

export interface FsReadTextFileParams {
  readonly sessionId: string;
  readonly path: string;
  readonly line?: number | undefined;
  readonly limit?: number | undefined;
}

export interface FsReadTextFileResult {
  readonly content: string;
}

export interface FsWriteTextFileParams {
  readonly sessionId: string;
  readonly path: string;
  readonly content: string;
}

const FsReadTextFileParamsSchema = z.object({
  sessionId: z.string(),
  path: z.string(),
  line: z.number().optional(),
  limit: z.number().optional(),
});

const FsWriteTextFileParamsSchema = z.object({
  sessionId: z.string(),
  path: z.string(),
  content: z.string(),
});

/** Parse fs/read_text_file params. Returns undefined if invalid. */
export function parseFsReadTextFileParams(value: unknown): FsReadTextFileParams | undefined {
  const r = FsReadTextFileParamsSchema.safeParse(value);
  return r.success ? r.data : undefined;
}

/** Parse fs/write_text_file params. Returns undefined if invalid. */
export function parseFsWriteTextFileParams(value: unknown): FsWriteTextFileParams | undefined {
  const r = FsWriteTextFileParamsSchema.safeParse(value);
  return r.success ? r.data : undefined;
}

// ---------------------------------------------------------------------------
// terminal/* (Agent → Koi, expects response)
// ---------------------------------------------------------------------------

export interface TerminalCreateParams {
  readonly sessionId: string;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly env?: readonly { readonly name: string; readonly value: string }[] | undefined;
  readonly cwd?: string | undefined;
  readonly outputByteLimit?: number | undefined;
}

export interface TerminalCreateResult {
  readonly terminalId: string;
}

export interface TerminalSessionParams {
  readonly sessionId: string;
  readonly terminalId: string;
}

export interface TerminalOutputResult {
  readonly output: string;
  readonly truncated: boolean;
  readonly exitStatus?:
    | {
        readonly exitCode: number;
        readonly signal: string | null;
      }
    | undefined;
}

export interface TerminalWaitForExitResult {
  readonly exitCode: number;
  readonly signal: string | null;
}

const TerminalCreateParamsSchema = z.object({
  sessionId: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  cwd: z.string().optional(),
  outputByteLimit: z.number().optional(),
});

const TerminalSessionParamsSchema = z.object({
  sessionId: z.string(),
  terminalId: z.string(),
});

/** Parse terminal/create params. Returns undefined if invalid. */
export function parseTerminalCreateParams(value: unknown): TerminalCreateParams | undefined {
  const r = TerminalCreateParamsSchema.safeParse(value);
  return r.success ? r.data : undefined;
}

/** Parse terminal session (output/kill/release/wait_for_exit) params. */
export function parseTerminalSessionParams(value: unknown): TerminalSessionParams | undefined {
  const r = TerminalSessionParamsSchema.safeParse(value);
  return r.success ? r.data : undefined;
}

// ---------------------------------------------------------------------------
// Validation helpers that return a typed result with error details
// (for use in adapter.ts where error messages are needed)
// ---------------------------------------------------------------------------

export interface ParseResult<T> {
  readonly success: true;
  readonly data: T;
}
export interface ParseError {
  readonly success: false;
  readonly error: string;
}
export type SafeParseResult<T> = ParseResult<T> | ParseError;

function makeParser<T>(schema: z.ZodType<T>): (value: unknown) => SafeParseResult<T> {
  return (value: unknown): SafeParseResult<T> => {
    const r = schema.safeParse(value);
    if (r.success) return { success: true, data: r.data };
    return { success: false, error: r.error.message };
  };
}

export const safeParseFsReadTextFileParams: (
  value: unknown,
) => SafeParseResult<FsReadTextFileParams> = makeParser(FsReadTextFileParamsSchema);

export const safeParseFsWriteTextFileParams: (
  value: unknown,
) => SafeParseResult<FsWriteTextFileParams> = makeParser(FsWriteTextFileParamsSchema);

export const safeParseTerminalCreateParams: (
  value: unknown,
) => SafeParseResult<TerminalCreateParams> = makeParser(TerminalCreateParamsSchema);

export const safeParseTerminalSessionParams: (
  value: unknown,
) => SafeParseResult<TerminalSessionParams> = makeParser(TerminalSessionParamsSchema);

export const safeParseSessionRequestPermissionParams: (
  value: unknown,
) => SafeParseResult<SessionRequestPermissionParams> = makeParser(
  SessionRequestPermissionParamsSchema,
);
