import { z } from "zod";

export type ReattachPolicy = false | "consent_required_if_missing" | "prompt_if_missing";

export interface HelloFrame {
  readonly kind: "hello";
  readonly token: string;
  readonly driverVersion: string;
  readonly supportedProtocols: readonly number[];
  readonly leaseToken: string;
  readonly admin?: { readonly adminKey: string } | undefined;
}

export interface HelloAckOkFrame {
  readonly kind: "hello_ack";
  readonly ok: true;
  readonly role: "driver" | "admin";
  readonly hostVersion: string;
  readonly extensionVersion: string | null;
  readonly wsEndpoint: string;
  readonly selectedProtocol: number;
}

export interface HelloAckFailFrame {
  readonly kind: "hello_ack";
  readonly ok: false;
  readonly reason:
    | "bad_token"
    | "bad_admin_key"
    | "lease_collision"
    | "bad_lease_token"
    | "extension_not_connected"
    | "version_mismatch";
  readonly hostSupportedProtocols?: readonly number[] | undefined;
}

export interface ListTabsFrame {
  readonly kind: "list_tabs";
  readonly requestId: string;
}

export interface TabsFrame {
  readonly kind: "tabs";
  readonly requestId: string;
  readonly tabs: readonly { readonly id: number; readonly url: string; readonly title: string }[];
}

export interface AttachFrame {
  readonly kind: "attach";
  readonly tabId: number;
  readonly leaseToken: string;
  readonly attachRequestId: string;
  readonly reattach?: ReattachPolicy | undefined;
}

export interface AttachAckOkFrame {
  readonly kind: "attach_ack";
  readonly ok: true;
  readonly tabId: number;
  readonly leaseToken: string;
  readonly attachRequestId: string;
  readonly sessionId: string;
}

export interface AttachAckFailFrame {
  readonly kind: "attach_ack";
  readonly ok: false;
  readonly tabId: number;
  readonly leaseToken: string;
  readonly attachRequestId: string;
  readonly reason:
    | "no_permission"
    | "tab_closed"
    | "user_denied"
    | "private_origin"
    | "timeout"
    | "already_attached"
    | "consent_required";
  readonly currentOwner?: { readonly clientId: string; readonly since: string } | undefined;
}

export interface DetachFrame {
  readonly kind: "detach";
  readonly sessionId: string;
}

export interface DetachAckFrame {
  readonly kind: "detach_ack";
  readonly sessionId: string;
  readonly ok: boolean;
  readonly reason?: "not_attached" | "chrome_error" | "timeout" | undefined;
}

export interface CdpFrame {
  readonly kind: "cdp";
  readonly sessionId: string;
  readonly method: string;
  readonly params: unknown;
  readonly id: number;
}

export interface CdpResultFrame {
  readonly kind: "cdp_result";
  readonly sessionId: string;
  readonly id: number;
  readonly result: unknown;
}

export interface CdpErrorFrame {
  readonly kind: "cdp_error";
  readonly sessionId: string;
  readonly id: number;
  readonly error: { readonly code: number; readonly message: string };
}

export interface CdpEventFrame {
  readonly kind: "cdp_event";
  readonly sessionId: string;
  readonly eventId: string;
  readonly method: string;
  readonly params: unknown;
}

export interface SessionEndedFrame {
  readonly kind: "session_ended";
  readonly sessionId: string;
  readonly tabId: number;
  readonly reason:
    | "navigated_away"
    | "private_origin"
    | "tab_closed"
    | "devtools_opened"
    | "extension_reload"
    | "unknown";
}

export interface ByeFrame {
  readonly kind: "bye";
}

export interface AdminClearGrantsFrame {
  readonly kind: "admin_clear_grants";
  readonly scope: "all" | "origin";
  readonly origin?: string | undefined;
}

export interface AdminClearGrantsAckOkFrame {
  readonly kind: "admin_clear_grants_ack";
  readonly ok: true;
  readonly clearedOrigins: readonly string[];
  readonly detachedTabs: readonly number[];
}

export interface AdminClearGrantsAckFailFrame {
  readonly kind: "admin_clear_grants_ack";
  readonly ok: false;
  readonly reason: "PERMISSION" | "timeout";
}

export interface ChunkFrame {
  readonly kind: "chunk";
  readonly sessionId: string;
  readonly correlationId: string;
  readonly payloadKind: "result_value" | "event_frame";
  readonly index: number;
  readonly total: number;
  readonly data: string;
}

export type DriverFrame =
  | HelloFrame
  | HelloAckOkFrame
  | HelloAckFailFrame
  | ListTabsFrame
  | TabsFrame
  | AttachFrame
  | AttachAckOkFrame
  | AttachAckFailFrame
  | DetachFrame
  | DetachAckFrame
  | CdpFrame
  | CdpResultFrame
  | CdpErrorFrame
  | CdpEventFrame
  | SessionEndedFrame
  | ByeFrame
  | AdminClearGrantsFrame
  | AdminClearGrantsAckOkFrame
  | AdminClearGrantsAckFailFrame
  | ChunkFrame;

const UUID = z.string().uuid();
const LeaseToken = z.string().regex(/^[0-9a-f]{32}$/);
const Token = z.string().min(16);

export const DriverFrameSchema: z.ZodType<DriverFrame> = z.union([
  z.object({
    kind: z.literal("hello"),
    token: Token,
    driverVersion: z.string(),
    supportedProtocols: z.array(z.number().int().positive()),
    leaseToken: LeaseToken,
    admin: z.object({ adminKey: Token }).optional(),
  }),
  z.discriminatedUnion("ok", [
    z.object({
      kind: z.literal("hello_ack"),
      ok: z.literal(true),
      role: z.union([z.literal("driver"), z.literal("admin")]),
      hostVersion: z.string(),
      extensionVersion: z.string().nullable(),
      wsEndpoint: z.string(),
      selectedProtocol: z.number().int().positive(),
    }),
    z.object({
      kind: z.literal("hello_ack"),
      ok: z.literal(false),
      reason: z.enum([
        "bad_token",
        "bad_admin_key",
        "lease_collision",
        "bad_lease_token",
        "extension_not_connected",
        "version_mismatch",
      ]),
      hostSupportedProtocols: z.array(z.number().int().positive()).optional(),
    }),
  ]),
  z.object({ kind: z.literal("list_tabs"), requestId: UUID }),
  z.object({
    kind: z.literal("tabs"),
    requestId: UUID,
    tabs: z.array(z.object({ id: z.number().int(), url: z.string(), title: z.string() })),
  }),
  z.object({
    kind: z.literal("attach"),
    tabId: z.number().int(),
    leaseToken: LeaseToken,
    attachRequestId: UUID,
    reattach: z
      .union([
        z.literal(false),
        z.literal("consent_required_if_missing"),
        z.literal("prompt_if_missing"),
      ])
      .optional(),
  }),
  z.discriminatedUnion("ok", [
    z.object({
      kind: z.literal("attach_ack"),
      ok: z.literal(true),
      tabId: z.number().int(),
      leaseToken: LeaseToken,
      attachRequestId: UUID,
      sessionId: UUID,
    }),
    z.object({
      kind: z.literal("attach_ack"),
      ok: z.literal(false),
      tabId: z.number().int(),
      leaseToken: LeaseToken,
      attachRequestId: UUID,
      reason: z.enum([
        "no_permission",
        "tab_closed",
        "user_denied",
        "private_origin",
        "timeout",
        "already_attached",
        "consent_required",
      ]),
      currentOwner: z.object({ clientId: z.string(), since: z.string() }).optional(),
    }),
  ]),
  z.object({ kind: z.literal("detach"), sessionId: UUID }),
  z.object({
    kind: z.literal("detach_ack"),
    sessionId: UUID,
    ok: z.boolean(),
    reason: z.enum(["not_attached", "chrome_error", "timeout"]).optional(),
  }),
  z.object({
    kind: z.literal("cdp"),
    sessionId: UUID,
    method: z.string(),
    params: z.unknown(),
    id: z.number().int(),
  }),
  z.object({
    kind: z.literal("cdp_result"),
    sessionId: UUID,
    id: z.number().int(),
    result: z.unknown(),
  }),
  z.object({
    kind: z.literal("cdp_error"),
    sessionId: UUID,
    id: z.number().int(),
    error: z.object({ code: z.number().int(), message: z.string() }),
  }),
  z.object({
    kind: z.literal("cdp_event"),
    sessionId: UUID,
    eventId: z.string(),
    method: z.string(),
    params: z.unknown(),
  }),
  z.object({
    kind: z.literal("session_ended"),
    sessionId: UUID,
    tabId: z.number().int(),
    reason: z.enum([
      "navigated_away",
      "private_origin",
      "tab_closed",
      "devtools_opened",
      "extension_reload",
      "unknown",
    ]),
  }),
  z.object({ kind: z.literal("bye") }),
  z.object({
    kind: z.literal("admin_clear_grants"),
    scope: z.enum(["all", "origin"]),
    origin: z.string().optional(),
  }),
  z.discriminatedUnion("ok", [
    z.object({
      kind: z.literal("admin_clear_grants_ack"),
      ok: z.literal(true),
      clearedOrigins: z.array(z.string()),
      detachedTabs: z.array(z.number().int()),
    }),
    z.object({
      kind: z.literal("admin_clear_grants_ack"),
      ok: z.literal(false),
      reason: z.enum(["PERMISSION", "timeout"]),
    }),
  ]),
  z.object({
    kind: z.literal("chunk"),
    sessionId: UUID,
    correlationId: z.string(),
    payloadKind: z.enum(["result_value", "event_frame"]),
    index: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    data: z.string(),
  }),
]);

const DRIVER_ORIGINATED_KINDS: ReadonlySet<DriverFrame["kind"]> = new Set([
  "hello",
  "list_tabs",
  "attach",
  "detach",
  "cdp",
  "admin_clear_grants",
  "bye",
]);

const HOST_ORIGINATED_KINDS: ReadonlySet<DriverFrame["kind"]> = new Set([
  "hello_ack",
  "tabs",
  "attach_ack",
  "detach_ack",
  "cdp_result",
  "cdp_error",
  "cdp_event",
  "session_ended",
  "admin_clear_grants_ack",
  "chunk",
]);

export function isDriverOriginated(frame: DriverFrame): boolean {
  return DRIVER_ORIGINATED_KINDS.has(frame.kind);
}

export function isHostOriginated(frame: DriverFrame): boolean {
  return HOST_ORIGINATED_KINDS.has(frame.kind);
}
