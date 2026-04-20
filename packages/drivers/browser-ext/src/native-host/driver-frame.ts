import { z } from "zod";

const UUID = z.string().uuid();
const LeaseToken = z.string().regex(/^[0-9a-f]{32}$/);
const Token = z.string().min(16);

const ReattachPolicy = z.union([
  z.literal(false),
  z.literal("consent_required_if_missing"),
  z.literal("prompt_if_missing"),
]);

const HelloSchema = z.object({
  kind: z.literal("hello"),
  token: Token,
  driverVersion: z.string(),
  supportedProtocols: z.array(z.number().int().positive()),
  leaseToken: LeaseToken,
  admin: z.object({ adminKey: Token }).optional(),
});

const HelloAckSchema = z.discriminatedUnion("ok", [
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
]);

const ListTabsSchema = z.object({ kind: z.literal("list_tabs") });
const TabsSchema = z.object({
  kind: z.literal("tabs"),
  tabs: z.array(z.object({ id: z.number().int(), url: z.string(), title: z.string() })),
});

const AttachSchema = z.object({
  kind: z.literal("attach"),
  tabId: z.number().int(),
  leaseToken: LeaseToken,
  attachRequestId: UUID,
  reattach: ReattachPolicy.optional(),
});

const AttachAckSchema = z.discriminatedUnion("ok", [
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
]);

const DetachSchema = z.object({ kind: z.literal("detach"), sessionId: UUID });
const DetachAckSchema = z.object({
  kind: z.literal("detach_ack"),
  sessionId: UUID,
  ok: z.boolean(),
  reason: z.enum(["not_attached", "chrome_error", "timeout"]).optional(),
});

const CdpSchema = z.object({
  kind: z.literal("cdp"),
  sessionId: UUID,
  method: z.string(),
  params: z.unknown(),
  id: z.number().int(),
});
const CdpResultSchema = z.object({
  kind: z.literal("cdp_result"),
  sessionId: UUID,
  id: z.number().int(),
  result: z.unknown(),
});
const CdpErrorSchema = z.object({
  kind: z.literal("cdp_error"),
  sessionId: UUID,
  id: z.number().int(),
  error: z.object({ code: z.number().int(), message: z.string() }),
});
const CdpEventSchema = z.object({
  kind: z.literal("cdp_event"),
  sessionId: UUID,
  eventId: z.string(),
  method: z.string(),
  params: z.unknown(),
});

const SessionEndedSchema = z.object({
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
});

const ByeSchema = z.object({ kind: z.literal("bye") });

const ChunkSchema = z.object({
  kind: z.literal("chunk"),
  sessionId: UUID,
  correlationId: z.string(),
  payloadKind: z.enum(["result_value", "event_frame"]),
  index: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  data: z.string(),
});

export const DriverFrameSchema = z.union([
  HelloSchema,
  HelloAckSchema,
  ListTabsSchema,
  TabsSchema,
  AttachSchema,
  AttachAckSchema,
  DetachSchema,
  DetachAckSchema,
  CdpSchema,
  CdpResultSchema,
  CdpErrorSchema,
  CdpEventSchema,
  SessionEndedSchema,
  ByeSchema,
  ChunkSchema,
]);

export type DriverFrame = z.infer<typeof DriverFrameSchema>;

const DRIVER_ORIGINATED_KINDS = new Set<DriverFrame["kind"]>([
  "hello",
  "list_tabs",
  "attach",
  "detach",
  "cdp",
  "bye",
]);

const HOST_ORIGINATED_KINDS = new Set<DriverFrame["kind"]>([
  "hello_ack",
  "tabs",
  "attach_ack",
  "detach_ack",
  "cdp_result",
  "cdp_error",
  "cdp_event",
  "session_ended",
  "chunk",
]);

export function isDriverOriginated(frame: DriverFrame): boolean {
  return DRIVER_ORIGINATED_KINDS.has(frame.kind);
}

export function isHostOriginated(frame: DriverFrame): boolean {
  return HOST_ORIGINATED_KINDS.has(frame.kind);
}
