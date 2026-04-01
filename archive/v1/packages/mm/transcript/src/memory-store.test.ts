import { describe } from "bun:test";
import { runSessionTranscriptContractTests } from "@koi/test-utils";
import { createInMemoryTranscript } from "./memory-store.js";

describe("InMemoryTranscript", () => {
  runSessionTranscriptContractTests(() => createInMemoryTranscript());
});
