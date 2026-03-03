/**
 * PayLedger contract tests against NexusPayLedger with mocked fetch.
 *
 * Uses a stateful mock HTTP server that simulates the Nexus pay API,
 * tracking balance, reservations, and transfers in memory.
 */

import { describe, test } from "bun:test";

// Contract tests require a fully stateful mock of the Nexus pay API
// (balance tracking, reservation lifecycle, transfer deduction).
// The local backend (@koi/pay-local) validates the shared contract suite.
// This file documents the wiring pattern for when a stateful Nexus mock
// is available.

describe("NexusPayLedger contract", () => {
  test.todo("wire runPayLedgerContractTests with stateful Nexus mock", () => {});
});

// Future implementation:
//
// import { runPayLedgerContractTests } from "@koi/test-utils";
// import { createNexusPayLedger } from "../ledger.js";
//
// function createStatefulMockFetch(): typeof globalThis.fetch { ... }
//
// runPayLedgerContractTests(() =>
//   createNexusPayLedger({
//     baseUrl: "https://mock.local",
//     apiKey: "test",
//     timeout: 5_000,
//     fetch: createStatefulMockFetch(),
//   }),
// );
