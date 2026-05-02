import type { SandboxProfile } from "@koi/core";
import { describeSandboxConformance } from "@koi/sandbox-conformance";
import { createSshAdapter } from "../adapter.js";
import type { SshClient, SshClientFactory } from "../types.js";

// Stub factory — conformance verifies the adapter contract shape, not real
// SSH transport. The SSH_E2E env-gated suite (future) covers real-server
// roundtrips. The 3 PR-1 conformance groups (lifecycle, create+destroy,
// capability-honesty) all run cleanly against this stub.
const stubFactory: SshClientFactory = {
  connect: async () => {
    const client: SshClient = {
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      end: async () => {},
    };
    return client;
  },
};

const profile: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: true },
  resources: {},
  ssh: { host: "stub.example", user: "user", keyPath: "/tmp/no-such-key" },
};

describeSandboxConformance(
  "@koi/sandbox-ssh",
  () => createSshAdapter({ clientFactory: stubFactory }),
  () => profile,
);
