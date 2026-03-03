/**
 * @koi/session-repair -- Message history repair pipeline (L0-utility)
 *
 * Pure function that validates and repairs message history before model calls.
 * Three-phase pipeline: orphan repair -> dedup -> merge.
 */

export { mapCallIdPairs } from "./map-call-id-pairs.js";
export { needsRepair } from "./needs-repair.js";
export { repairSession } from "./repair-session.js";
export type { CallIdPairMap, RepairIssue, RepairResult } from "./types.js";
