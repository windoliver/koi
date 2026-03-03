/**
 * AuditSink contract tests against NexusAuditSink with mocked NexusClient.
 *
 * The Nexus audit sink writes entries as JSON files to a Nexus store path.
 * Contract tests require a mock NexusClient that stores and retrieves entries.
 */

import { describe, test } from "bun:test";

// Contract tests require a mock NexusClient that implements file storage
// for the audit path convention ({basePath}/{sessionId}/{timestamp}-{turnIndex}-{kind}.json).
// The local backend (@koi/audit-sink-local) validates the shared contract suite.

describe("NexusAuditSink contract", () => {
  test.todo("wire runAuditSinkContractTests with mocked NexusClient", () => {});
});

// Future implementation:
//
// import { runAuditSinkContractTests } from "@koi/test-utils";
// import { createNexusAuditSink } from "../nexus-sink.js";
// import { createFakeNexusFetch } from "@koi/test-utils";
//
// runAuditSinkContractTests({
//   createSink: () => {
//     const sink = createNexusAuditSink({
//       baseUrl: "https://mock.local",
//       apiKey: "test",
//       fetch: createFakeNexusFetch(),
//     });
//     return { sink, getEntries: () => { /* read back from mock store */ } };
//   },
// });
