/**
 * ScratchpadComponent contract tests against NexusScratchpad with mocked fetch.
 *
 * The fake Nexus fetch in @koi/test-utils already implements scratchpad RPC
 * methods (scratchpad.write, scratchpad.read, scratchpad.list, scratchpad.delete).
 */

import { describe, test } from "bun:test";

// The scratchpad adapter requires a ScratchpadClient + WriteBuffer + GenerationCache,
// which in turn need a configured NexusClient with JSON-RPC scratchpad methods.
// createFakeNexusFetch in @koi/test-utils already supports these methods.
// The local backend (@koi/scratchpad-local) validates the shared contract suite.

describe("NexusScratchpad contract", () => {
  test.todo("wire runScratchpadContractTests with createFakeNexusFetch", () => {});
});

// Future implementation:
//
// import { runScratchpadContractTests } from "@koi/test-utils";
// import { createFakeNexusFetch } from "@koi/test-utils";
// import { createScratchpadClient } from "../scratchpad-client.js";
//
// runScratchpadContractTests(() => {
//   const fetch = createFakeNexusFetch();
//   /* Wire scratchpad adapter with fake fetch */
// });
