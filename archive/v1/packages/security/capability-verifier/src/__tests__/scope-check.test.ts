/**
 * Scope-check unit tests — Issue 4B: allow/deny asymmetry.
 *
 * Documents the intentional asymmetry between allow and deny list matching
 * in isToolAllowed:
 *
 * - **Allow** matches by toolName only (coarse-grained, tool-level).
 *   Resource-scoped entries in the allow list are NOT matched.
 * - **Deny** matches both toolName AND full toolId (fine-grained).
 *   You can deny an entire tool or a specific resource path.
 *
 * This asymmetry is security-conservative: allow is broad, deny is precise.
 */

import { describe, expect, test } from "bun:test";
import type { CapabilityToken } from "@koi/core";
import { agentId, capabilityId, sessionId } from "@koi/core";
import { isToolAllowed } from "../scope-check.js";

const SESSION = sessionId("scope-test-session");

/**
 * Build a minimal CapabilityToken fixture with the given permission config.
 * Uses a dummy HMAC proof — isToolAllowed does not inspect proof fields.
 */
function makeToken(allow?: readonly string[], deny?: readonly string[]): CapabilityToken {
  // Build permissions without setting undefined values (exactOptionalPropertyTypes)
  const permissions = {
    ...(allow !== undefined ? { allow } : {}),
    ...(deny !== undefined ? { deny } : {}),
  };
  return {
    id: capabilityId("cap-scope-test"),
    issuerId: agentId("agent-issuer"),
    delegateeId: agentId("agent-delegatee"),
    scope: {
      permissions,
      sessionId: SESSION,
    },
    chainDepth: 0,
    maxChainDepth: 3,
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 3600000,
    proof: { kind: "hmac-sha256", digest: "0".repeat(64) },
  };
}

describe("isToolAllowed — allow/deny asymmetry", () => {
  test("allow matches by toolName only, ignoring resource path", () => {
    const token = makeToken(["read_file"]);

    // "read_file:/etc/passwd" has toolName "read_file" which is in the allow list
    expect(isToolAllowed("read_file:/etc/passwd", token)).toBe(true);
  });

  test("resource-scoped entries in allow list are NOT matched", () => {
    const token = makeToken(["read_file:/safe/dir"]);

    // The allow list entry "read_file:/safe/dir" is never matched because
    // allow compares against toolName ("read_file") not the full toolId.
    // "read_file:/safe/dir" as an allow entry does not equal toolName "read_file".
    expect(isToolAllowed("read_file:/safe/dir", token)).toBe(false);
  });

  test("deny matches both toolName and full toolId", () => {
    const token = makeToken(["*"], ["write_file:/etc/passwd"]);

    // Full toolId deny — exact match blocks this specific resource
    expect(isToolAllowed("write_file:/etc/passwd", token)).toBe(false);

    // Different resource path — not denied, wildcard allow still applies
    expect(isToolAllowed("write_file:/safe/dir", token)).toBe(true);
  });

  test("deny by toolName blocks all resources", () => {
    const token = makeToken(["*"], ["write_file"]);

    // toolName "write_file" is in deny list — blocks any resource path
    expect(isToolAllowed("write_file:/anything", token)).toBe(false);

    // Also blocks bare tool name without resource path
    expect(isToolAllowed("write_file", token)).toBe(false);
  });

  test("wildcard allow permits any tool", () => {
    const token = makeToken(["*"]);

    expect(isToolAllowed("any_exotic_tool", token)).toBe(true);
  });
});
