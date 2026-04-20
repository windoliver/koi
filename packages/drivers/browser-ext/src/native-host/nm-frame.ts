import { z } from "zod";

const UUID = z.string().uuid();
const LeaseToken = z.string().regex(/^[0-9a-f]{32}$/);

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
  reattach: z
    .union([
      z.literal(false),
      z.literal("consent_required_if_missing"),
      z.literal("prompt_if_missing"),
    ])
    .optional(),
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

const DetachSchema = z.object({
  kind: z.literal("detach"),
  sessionId: UUID,
  tabId: z.number().int(),
});

const DetachAckSchema = z.object({
  kind: z.literal("detach_ack"),
  sessionId: UUID,
  tabId: z.number().int(),
  ok: z.boolean(),
  reason: z.enum(["not_attached", "chrome_error", "timeout"]).optional(),
});

const AbandonAttachSchema = z.object({
  kind: z.literal("abandon_attach"),
  leaseToken: LeaseToken,
});

const AbandonAttachAckSchema = z.object({
  kind: z.literal("abandon_attach_ack"),
  leaseToken: LeaseToken,
  affectedTabs: z.array(z.number().int()),
});

const AdminClearGrantsSchema = z.object({
  kind: z.literal("admin_clear_grants"),
  scope: z.enum(["all", "origin"]),
  origin: z.string().optional(),
});

const AdminClearGrantsAckSchema = z.object({
  kind: z.literal("admin_clear_grants_ack"),
  clearedOrigins: z.array(z.string()),
  detachedTabs: z.array(z.number().int()),
});

const AttachStateProbeSchema = z.object({
  kind: z.literal("attach_state_probe"),
  requestId: z.string(),
});

const AttachStateProbeAckSchema = z.object({
  kind: z.literal("attach_state_probe_ack"),
  requestId: z.string(),
  attachedTabs: z.array(z.number().int()),
});

const DetachedSchema = z.object({
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

const ChunkSchema = z.object({
  kind: z.literal("chunk"),
  sessionId: UUID,
  correlationId: z.string(),
  payloadKind: z.enum(["result_value", "event_frame"]),
  index: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  data: z.string(),
});

export const NmFrameSchema = z.union([
  ListTabsSchema,
  TabsSchema,
  AttachSchema,
  AttachAckSchema,
  DetachSchema,
  DetachAckSchema,
  AbandonAttachSchema,
  AbandonAttachAckSchema,
  AdminClearGrantsSchema,
  AdminClearGrantsAckSchema,
  AttachStateProbeSchema,
  AttachStateProbeAckSchema,
  DetachedSchema,
  CdpSchema,
  CdpResultSchema,
  CdpErrorSchema,
  CdpEventSchema,
  ChunkSchema,
]);

export type NmFrame = z.infer<typeof NmFrameSchema>;

const HOST_ORIGINATED_KINDS = new Set<NmFrame["kind"]>([
  "list_tabs",
  "attach",
  "detach",
  "abandon_attach",
  "admin_clear_grants",
  "attach_state_probe",
  "cdp",
]);

const EXTENSION_ORIGINATED_KINDS = new Set<NmFrame["kind"]>([
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
