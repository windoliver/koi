/**
 * Run the reusable TaskStore + ScheduleStore contract tests against SQLite.
 */

import { Database } from "bun:sqlite";
import { runScheduleStoreContractTests, runTaskStoreContractTests } from "@koi/test-utils";
import type { SqliteTaskStore } from "../sqlite-store.js";
import { createSqliteTaskStore } from "../sqlite-store.js";

let db: Database;
let store: SqliteTaskStore;

function recreate(): SqliteTaskStore {
  db = new Database(":memory:");
  store = createSqliteTaskStore(db);
  return store;
}

runTaskStoreContractTests(() => recreate());

// SqliteTaskStore implements both TaskStore and ScheduleStore
runScheduleStoreContractTests(() => recreate());
