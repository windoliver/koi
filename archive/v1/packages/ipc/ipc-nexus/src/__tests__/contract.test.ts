/**
 * MailboxComponent contract tests against NexusMailbox with mocked fetch.
 *
 * The Nexus mailbox adapter uses REST endpoints for send/list and
 * SSE/polling for push delivery.
 */

import { describe, test } from "bun:test";

// Contract tests require a mock Nexus IPC REST server that handles:
// - POST /messages (send)
// - GET /messages (list with filters)
// - SSE /events (push delivery)
// The local backend (@koi/ipc-local) validates the shared contract suite.

describe("NexusMailbox contract", () => {
  test.todo("wire runMailboxContractTests with stateful Nexus IPC mock", () => {});
});

// Future implementation:
//
// import { runMailboxContractTests } from "@koi/test-utils";
// import { createNexusMailbox } from "../mailbox-adapter.js";
//
// runMailboxContractTests(() =>
//   createNexusMailbox({
//     baseUrl: "https://mock.local",
//     apiKey: "test",
//     agentId: agentId("agent-1"),
//     fetch: createStatefulMockFetch(),
//   }),
// );
