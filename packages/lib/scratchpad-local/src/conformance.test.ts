import { agentGroupId, agentId } from "@koi/core";
import { describeScratchpadConformance } from "@koi/scratchpad-conformance";
import { createLocalScratchpad } from "./scratchpad.js";

let counter = 0;

describeScratchpadConformance("createLocalScratchpad", () =>
  createLocalScratchpad({
    groupId: agentGroupId(`conformance-${++counter}`),
    authorId: agentId("conformance-author"),
    sweepIntervalMs: 0,
  }),
);
