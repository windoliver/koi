import { describe, test } from "bun:test";

const runE2E = process.env.KOI_TEST_EXTENSION_E2E === "1";

describe("uninstall-reinstall revocation integration", () => {
  (runE2E ? test : test.skip)(
    "wipes grants when host_hello carries a new installId after reinstall",
    async () => {
      // TODO(P4): implement the real Chromium + host-shim reinstall harness.
    },
  );
});
