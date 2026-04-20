import { z } from "zod";

export interface NmListTabs {
  readonly kind: "list_tabs";
}

export interface NmTabs {
  readonly kind: "tabs";
  readonly tabs: readonly { readonly id: number; readonly url: string; readonly title: string }[];
}

export interface NmAttach {
  readonly kind: "attach";
  readonly tabId: number;
  readonly leaseToken: string;
  readonly attachRequestId: string;
  readonly reattach?: false | "consent_required_if_missing" | "prompt_if_missing" | undefined;
}

export interface NmAttachAckOk {
  readonly kind: "attach_ack";
  readonly ok: true;
  readonly tabId: number;
  readonly leaseToken: string;
  readonly attachRequestId: string;
  readonly sessionId: string;
}

export interface NmAttachAckFail {
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

export interface NmDetach {
  readonly kind: "detach";
  readonly sessionId: string;
  readonly tabId: number;
}

export interface NmDetachAck {
  readonly kind: "detach_ack";
  readonly sessionId: string;
  readonly tabId: number;
  readonly ok: boolean;
  readonly reason?: "not_attached" | "chrome_error" | "timeout" | undefined;
}

export interface NmAbandonAttach {
  readonly kind: "abandon_attach";
  readonly leaseToken: string;
}

export interface NmAbandonAttachAck {
  readonly kind: "abandon_attach_ack";
  readonly leaseToken: string;
  readonly affectedTabs: readonly number[];
}

export interface NmAdminClearGrants {
  readonly kind: "admin_clear_grants";
  readonly scope: "all" | "origin";
  readonly origin?: string | undefined;
}

export interface NmAdminClearGrantsAck {
  readonly kind: "admin_clear_grants_ack";
  readonly clearedOrigins: readonly string[];
  readonly detachedTabs: readonly number[];
}

export interface NmAttachStateProbe {
  readonly kind: "attach_state_probe";
  readonly requestId: string;
}

export interface NmAttachStateProbeAck {
  readonly kind: "attach_state_probe_ack";
  readonly requestId: string;
  readonly attachedTabs: readonly number[];
}

export interface NmDetached {
  readonly kind: "detached";
  readonly sessionId: string;
  readonly tabId: number;
  readonly reason:
    | "navigated_away"
    | "private_origin"
    | "tab_closed"
    | "devtools_opened"
    | "extension_reload"
    | "unknown";
  readonly priorDetachSuccess?: boolean | undefined;
}

export interface NmCdp {
  readonly kind: "cdp";
  readonly sessionId: string;
  readonly method: string;
  readonly params: unknown;
  readonly id: number;
}

export interface NmCdpResult {
  readonly kind: "cdp_result";
  readonly sessionId: string;
  readonly id: number;
  readonly result: unknown;
}

export interface NmCdpError {
  readonly kind: "cdp_error";
  readonly sessionId: string;
  readonly id: number;
  readonly error: { readonly code: number; readonly message: string };
}

export interface NmCdpEvent {
  readonly kind: "cdp_event";
  readonly sessionId: string;
  readonly eventId: string;
  readonly method: string;
  readonly params: unknown;
}

export interface NmChunk {
  readonly kind: "chunk";
  readonly sessionId: string;
  readonly correlationId: string;
  readonly payloadKind: "result_value" | "event_frame";
  readonly index: number;
  readonly total: number;
  readonly data: string;
}

export type NmFrame =
  | NmListTabs
  | NmTabs
  | NmAttach
  | NmAttachAckOk
  | NmAttachAckFail
  | NmDetach
  | NmDetachAck
  | NmAbandonAttach
  | NmAbandonAttachAck
  | NmAdminClearGrants
  | NmAdminClearGrantsAck
  | NmAttachStateProbe
  | NmAttachStateProbeAck
  | NmDetached
  | NmCdp
  | NmCdpResult
  | NmCdpError
  | NmCdpEvent
  | NmChunk;

const UUID = z.string().uuid();
const LeaseToken = z.string().regex(/^[0-9a-f]{32}$/);

export const NmFrameSchema: z.ZodType<NmFrame> = z.union([
  z.object({ kind: z.literal("list_tabs") }),
  z.object({
    kind: z.literal("tabs"),
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
  z.object({ kind: z.literal("detach"), sessionId: UUID, tabId: z.number().int() }),
  z.object({
    kind: z.literal("detach_ack"),
    sessionId: UUID,
    tabId: z.number().int(),
    ok: z.boolean(),
    reason: z.enum(["not_attached", "chrome_error", "timeout"]).optional(),
  }),
  z.object({ kind: z.literal("abandon_attach"), leaseToken: LeaseToken }),
  z.object({
    kind: z.literal("abandon_attach_ack"),
    leaseToken: LeaseToken,
    affectedTabs: z.array(z.number().int()),
  }),
  z.object({
    kind: z.literal("admin_clear_grants"),
    scope: z.enum(["all", "origin"]),
    origin: z.string().optional(),
  }),
  z.object({
    kind: z.literal("admin_clear_grants_ack"),
    clearedOrigins: z.array(z.string()),
    detachedTabs: z.array(z.number().int()),
  }),
  z.object({ kind: z.literal("attach_state_probe"), requestId: z.string() }),
  z.object({
    kind: z.literal("attach_state_probe_ack"),
    requestId: z.string(),
    attachedTabs: z.array(z.number().int()),
  }),
  z.object({
    kind: z.literal("detached"),
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
    priorDetachSuccess: z.boolean().optional(),
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
    kind: z.literal("chunk"),
    sessionId: UUID,
    correlationId: z.string(),
    payloadKind: z.enum(["result_value", "event_frame"]),
    index: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    data: z.string(),
  }),
]);

const HOST_ORIGINATED_KINDS: ReadonlySet<NmFrame["kind"]> = new Set([
  "list_tabs",
  "attach",
  "detach",
  "abandon_attach",
  "admin_clear_grants",
  "attach_state_probe",
  "cdp",
]);

const EXTENSION_ORIGINATED_KINDS: ReadonlySet<NmFrame["kind"]> = new Set([
  "tabs",
  "attach_ack",
  "detach_ack",
  "abandon_attach_ack",
  "admin_clear_grants_ack",
  "attach_state_probe_ack",
  "detached",
  "cdp_result",
  "cdp_error",
  "cdp_event",
  "chunk",
]);

export function isHostOriginatedNm(frame: NmFrame): boolean {
  return HOST_ORIGINATED_KINDS.has(frame.kind);
}

export function isExtensionOriginated(frame: NmFrame): boolean {
  return EXTENSION_ORIGINATED_KINDS.has(frame.kind);
}
