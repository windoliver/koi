/**
 * Network policy resolution for Docker containers.
 *
 * Maps NetworkPolicy to Docker network mode and optional iptables script.
 * Three modes:
 *
 * | allow | allowedHosts     | Docker behavior                                   |
 * |-------|------------------|----------------------------------------------------|
 * | false | N/A              | --network=none                                     |
 * | true  | undefined/empty  | --network=bridge (full access)                     |
 * | true  | ["host", ...]    | --network=bridge + CAP_NET_ADMIN + iptables script |
 */

import type { NetworkPolicy } from "@koi/core";

/** Resolved network configuration for a Docker container. */
export interface DockerNetworkConfig {
  readonly networkMode: "none" | "bridge";
  readonly capAdd: readonly string[];
  readonly iptablesSetupScript: string | undefined;
}

/**
 * Resolve a NetworkPolicy into Docker network configuration.
 *
 * When `allowedHosts` is specified, generates an iptables script that:
 * 1. Accepts loopback traffic
 * 2. Accepts established/related connections
 * 3. Accepts DNS (UDP/TCP 53) for hostname resolution
 * 4. Resolves each host via `getent hosts` and accepts its IPs
 * 5. Sets default OUTPUT policy to DROP
 */
export function resolveNetworkConfig(network: NetworkPolicy): DockerNetworkConfig {
  if (!network.allow) {
    return {
      networkMode: "none",
      capAdd: [],
      iptablesSetupScript: undefined,
    };
  }

  const hosts = network.allowedHosts;
  if (hosts === undefined || hosts.length === 0) {
    return {
      networkMode: "bridge",
      capAdd: [],
      iptablesSetupScript: undefined,
    };
  }

  return {
    networkMode: "bridge",
    capAdd: ["NET_ADMIN"],
    iptablesSetupScript: buildIptablesScript(hosts),
  };
}

/**
 * Build an iptables setup script for host-level filtering.
 *
 * Hostname resolution happens at container runtime via `getent hosts`,
 * avoiding DNS-at-build-time fragility.
 */
function buildIptablesScript(hosts: readonly string[]): string {
  const lines: string[] = [
    "#!/bin/sh",
    "set -e",
    "",
    "# Accept loopback",
    "iptables -A OUTPUT -o lo -j ACCEPT",
    "",
    "# Accept established/related connections",
    "iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT",
    "",
    "# Accept DNS (needed to resolve hostnames)",
    "iptables -A OUTPUT -p udp --dport 53 -j ACCEPT",
    "iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT",
    "",
    "# Accept traffic to allowed hosts",
  ];

  for (const host of hosts) {
    const safeHost = sanitizeHost(host);
    if (safeHost === undefined) continue;
    lines.push(
      `for ip in $(getent hosts ${safeHost} | awk '{print $1}'); do`,
      `  iptables -A OUTPUT -d "$ip" -j ACCEPT`,
      "done",
    );
  }

  lines.push("", "# Drop everything else", "iptables -P OUTPUT DROP");

  return lines.join("\n");
}

/** Sanitize a hostname for safe shell interpolation. Returns undefined if empty after cleaning. */
function sanitizeHost(host: string): string | undefined {
  // Only allow alphanumeric, dots, hyphens, and colons (for IPv6)
  const cleaned = host.replace(/[^a-zA-Z0-9.\-:]/g, "");
  return cleaned === "" ? undefined : cleaned;
}
