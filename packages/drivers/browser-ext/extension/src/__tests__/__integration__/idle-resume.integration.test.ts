import { describe, test } from "bun:test";

const runE2E = process.env.KOI_TEST_EXTENSION_E2E === "1";

describe("idle-resume integration", () => {
  (runE2E ? test : test.skip)(
    "holds the MV3 worker open across a 90s idle period in real Chromium",
    async () => {
      // TODO(P4): implement Playwright launchPersistentContext harness when the
      // native-host install flow from later stack steps is available locally.
    },
  );
});
