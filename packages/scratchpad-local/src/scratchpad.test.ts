import { describe, expect, test } from "bun:test";
import { agentGroupId, agentId, SCRATCHPAD_DEFAULTS, scratchpadPath } from "@koi/core";
import { runScratchpadContractTests } from "@koi/test-utils";
import { createLocalScratchpad } from "./scratchpad.js";

// ---------------------------------------------------------------------------
// Contract test suite
// ---------------------------------------------------------------------------

runScratchpadContractTests(() =>
  createLocalScratchpad({
    groupId: agentGroupId("group-1"),
    authorId: agentId("author-1"),
    sweepIntervalMs: 60_000,
  }),
);

// ---------------------------------------------------------------------------
// Local-specific unit tests
// ---------------------------------------------------------------------------

describe("createLocalScratchpad — local specifics", () => {
  test("close clears all entries and subscribers", async () => {
    const pad = createLocalScratchpad({
      groupId: agentGroupId("g"),
      authorId: agentId("a"),
    });
    await pad.write({ path: scratchpadPath("test.txt"), content: "hello" });
    const events: unknown[] = [];
    pad.onChange((evt) => events.push(evt));
    pad.close();

    // After close, reading should fail
    const result = await pad.read(scratchpadPath("test.txt"));
    expect(result.ok).toBe(false);
  });

  test("TTL-expired entries are lazily evicted on read", async () => {
    const pad = createLocalScratchpad({
      groupId: agentGroupId("g"),
      authorId: agentId("a"),
      sweepIntervalMs: 60_000, // Don't rely on sweep
    });

    await pad.write({
      path: scratchpadPath("ephemeral.txt"),
      content: "temporary",
      ttlSeconds: 0, // Expires immediately (or nearly)
    });

    // Wait for TTL to pass
    await Bun.sleep(50);

    const result = await pad.read(scratchpadPath("ephemeral.txt"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }

    pad.close();
  });

  test("TTL-expired entries are excluded from list", async () => {
    const pad = createLocalScratchpad({
      groupId: agentGroupId("g"),
      authorId: agentId("a"),
    });

    await pad.write({
      path: scratchpadPath("kept.txt"),
      content: "stays",
    });
    await pad.write({
      path: scratchpadPath("gone.txt"),
      content: "expires",
      ttlSeconds: 0,
    });

    await Bun.sleep(50);

    const list = await pad.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.path).toBe(scratchpadPath("kept.txt"));

    pad.close();
  });

  test("file count limit is enforced", async () => {
    const pad = createLocalScratchpad({
      groupId: agentGroupId("g"),
      authorId: agentId("a"),
    });

    // Write up to the limit
    for (const i of Array.from({ length: SCRATCHPAD_DEFAULTS.MAX_FILES_PER_GROUP }, (_, j) => j)) {
      const result = await pad.write({
        path: scratchpadPath(`file-${i}.txt`),
        content: "x",
      });
      expect(result.ok).toBe(true);
    }

    // One more should fail
    const overflow = await pad.write({
      path: scratchpadPath("overflow.txt"),
      content: "x",
    });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error.code).toBe("VALIDATION");
    }

    pad.close();
  });

  test("entry includes groupId and authorId from config", async () => {
    const pad = createLocalScratchpad({
      groupId: agentGroupId("test-group"),
      authorId: agentId("test-author"),
    });

    await pad.write({ path: scratchpadPath("meta.txt"), content: "data" });
    const result = await pad.read(scratchpadPath("meta.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.groupId).toBe(agentGroupId("test-group"));
    expect(result.value.authorId).toBe(agentId("test-author"));

    pad.close();
  });
});
