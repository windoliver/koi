/**
 * In-memory ReplacementStore contract tests.
 *
 * Runs the shared contract suite against createInMemoryReplacementStore.
 */

import { createInMemoryReplacementStore } from "../replacement.js";
import { runReplacementStoreContract } from "./replacement-store.contract.js";

runReplacementStoreContract(() => createInMemoryReplacementStore(), "InMemoryReplacementStore");
