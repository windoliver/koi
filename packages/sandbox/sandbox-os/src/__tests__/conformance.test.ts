import type { SandboxProfile } from "@koi/core";
import { describeSandboxConformance } from "@koi/sandbox-conformance";
import { createOsAdapterForTest } from "../adapter.js";

// Use the test factory so the suite runs without requiring sandbox-exec/bwrap
// to be installed in the test environment. The conformance suite checks
// adapter contract shape, not real subprocess isolation.
const profile: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: false },
  resources: {},
};

describeSandboxConformance(
  "@koi/sandbox-os",
  () =>
    createOsAdapterForTest({
      platform: "seatbelt",
      available: true,
    }),
  () => profile,
);
