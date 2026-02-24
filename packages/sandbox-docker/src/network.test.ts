import { describe, expect, test } from "bun:test";
import { resolveNetworkConfig } from "./network.js";

describe("resolveNetworkConfig", () => {
  test("returns network=none when allow is false", () => {
    const result = resolveNetworkConfig({ allow: false });
    expect(result.networkMode).toBe("none");
    expect(result.capAdd).toEqual([]);
    expect(result.iptablesSetupScript).toBeUndefined();
  });

  test("returns network=bridge when allow is true and no allowedHosts", () => {
    const result = resolveNetworkConfig({ allow: true });
    expect(result.networkMode).toBe("bridge");
    expect(result.capAdd).toEqual([]);
    expect(result.iptablesSetupScript).toBeUndefined();
  });

  test("returns network=bridge when allowedHosts is empty", () => {
    const result = resolveNetworkConfig({ allow: true, allowedHosts: [] });
    expect(result.networkMode).toBe("bridge");
    expect(result.capAdd).toEqual([]);
    expect(result.iptablesSetupScript).toBeUndefined();
  });

  test("returns bridge + CAP_NET_ADMIN + iptables when allowedHosts specified", () => {
    const result = resolveNetworkConfig({
      allow: true,
      allowedHosts: ["api.example.com"],
    });
    expect(result.networkMode).toBe("bridge");
    expect(result.capAdd).toEqual(["NET_ADMIN"]);
    expect(result.iptablesSetupScript).toBeDefined();
  });

  test("iptables script contains loopback rule", () => {
    const result = resolveNetworkConfig({
      allow: true,
      allowedHosts: ["api.example.com"],
    });
    expect(result.iptablesSetupScript).toContain("iptables -A OUTPUT -o lo -j ACCEPT");
  });

  test("iptables script contains DNS rules", () => {
    const result = resolveNetworkConfig({
      allow: true,
      allowedHosts: ["api.example.com"],
    });
    expect(result.iptablesSetupScript).toContain("--dport 53");
  });

  test("iptables script contains established/related rule", () => {
    const result = resolveNetworkConfig({
      allow: true,
      allowedHosts: ["api.example.com"],
    });
    expect(result.iptablesSetupScript).toContain("ESTABLISHED,RELATED");
  });

  test("iptables script resolves each host via getent", () => {
    const result = resolveNetworkConfig({
      allow: true,
      allowedHosts: ["api.example.com", "cdn.example.com"],
    });
    expect(result.iptablesSetupScript).toBeDefined();
    const script = result.iptablesSetupScript ?? "";
    expect(script).toContain("getent hosts api.example.com");
    expect(script).toContain("getent hosts cdn.example.com");
  });

  test("iptables script drops all other traffic", () => {
    const result = resolveNetworkConfig({
      allow: true,
      allowedHosts: ["api.example.com"],
    });
    expect(result.iptablesSetupScript).toContain("iptables -P OUTPUT DROP");
  });

  test("sanitizes hostnames to prevent injection", () => {
    const result = resolveNetworkConfig({
      allow: true,
      allowedHosts: ["host; rm -rf /"],
    });
    expect(result.iptablesSetupScript).toBeDefined();
    const script = result.iptablesSetupScript ?? "";
    // Dangerous characters should be stripped from the hostname
    expect(script).not.toContain("host;");
    expect(script).not.toContain("rm -rf");
    expect(script).toContain("getent hosts hostrm-rf");
  });

  test("allows IPv6 colons in hostnames", () => {
    const result = resolveNetworkConfig({
      allow: true,
      allowedHosts: ["::1"],
    });
    expect(result.iptablesSetupScript).toBeDefined();
    const script = result.iptablesSetupScript ?? "";
    expect(script).toContain("getent hosts ::1");
  });

  test("skips hosts that sanitize to empty string", () => {
    const result = resolveNetworkConfig({
      allow: true,
      allowedHosts: ["!@#$%"],
    });
    expect(result.iptablesSetupScript).toBeDefined();
    const script = result.iptablesSetupScript ?? "";
    // Host was all special chars, so getent should not appear for it
    expect(script).not.toContain("getent hosts ");
  });

  test("ignores allowedHosts when allow is false", () => {
    const result = resolveNetworkConfig({
      allow: false,
      allowedHosts: ["api.example.com"],
    });
    expect(result.networkMode).toBe("none");
    expect(result.iptablesSetupScript).toBeUndefined();
  });
});
