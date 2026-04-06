import { describe } from "bun:test";
import { createInMemoryTranscript } from "../transcript/memory-store.js";
import { runSessionTranscriptContractTests } from "./contracts/transcript-contract.js";

describe("InMemoryTranscript", () => {
  runSessionTranscriptContractTests(() => createInMemoryTranscript());
});
