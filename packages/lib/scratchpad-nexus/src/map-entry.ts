import {
  agentGroupId,
  agentId,
  scratchpadPath,
  type ScratchpadEntry,
  type ScratchpadEntrySummary,
} from "../../../kernel/core/src/index.js";
import type { NexusScratchpadEntryRecord, NexusScratchpadListResponse } from "./types.js";

export function mapEntry(record: NexusScratchpadEntryRecord): ScratchpadEntry {
  return {
    ...record,
    path: scratchpadPath(record.path),
    groupId: agentGroupId(record.groupId),
    authorId: agentId(record.authorId),
  };
}

export function mapSummaries(response: NexusScratchpadListResponse): readonly ScratchpadEntrySummary[] {
  return response.entries.map((entry) => ({
    ...entry,
    path: scratchpadPath(entry.path),
    groupId: agentGroupId(entry.groupId),
    authorId: agentId(entry.authorId),
  }));
}
