/**
 * Shared test fixtures for @koi/doctor tests.
 */

import type { AgentManifest } from "@koi/core";

/**
 * Minimal valid manifest — no security features configured.
 * Most rules will fire against this manifest.
 */
export function createInsecureManifest(): AgentManifest {
  return {
    name: "insecure-agent",
    version: "1.0.0",
    model: { name: "claude-3.5-sonnet" },
    tools: [{ name: "exec" }, { name: "read_file" }],
    middleware: [{ name: "memory" }],
    delegation: {
      enabled: true,
      maxChainDepth: 10,
      defaultTtlMs: 172_800_000, // 48 hours
    },
  };
}

/**
 * Maximally secure manifest — all recommended security features.
 * No rules should fire against this manifest (except informational).
 */
export function createSecureManifest(): AgentManifest {
  return {
    name: "secure-agent",
    version: "1.0.0",
    model: {
      name: "claude-3.5-sonnet",
      options: { systemPromptDefense: true },
    },
    tools: [{ name: "read_file" }, { name: "write_file" }],
    middleware: [
      { name: "sanitize" },
      { name: "guardrails" },
      { name: "sandbox" },
      { name: "permissions" },
      { name: "redaction" },
      { name: "call-limits" },
      { name: "budget" },
      { name: "compactor" },
      { name: "turn-ack" },
      { name: "audit" },
      { name: "governance" },
      { name: "agent-monitor" },
      { name: "a2a-auth" },
      { name: "memory" },
    ],
    permissions: {
      allow: ["read_file", "write_file"],
      deny: ["exec", "shell", "eval"],
      ask: ["write_file"],
    },
    delegation: {
      enabled: true,
      maxChainDepth: 3,
      defaultTtlMs: 3_600_000, // 1 hour
    },
    metadata: {
      forge: { verification: true },
    },
  };
}

/**
 * Bare minimum manifest — no tools, no middleware, no delegation.
 */
export function createMinimalManifest(): AgentManifest {
  return {
    name: "minimal-agent",
    version: "0.1.0",
    model: { name: "claude-3.5-sonnet" },
  };
}
