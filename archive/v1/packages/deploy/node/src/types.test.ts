import { describe, expect, it } from "bun:test";
import { parseNodeConfig } from "./types.js";

describe("parseNodeConfig", () => {
  it("rejects null input", () => {
    const result = parseNodeConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  it("rejects undefined input", () => {
    const result = parseNodeConfig(undefined);
    expect(result.ok).toBe(false);
  });

  it("rejects missing gateway.url", () => {
    const result = parseNodeConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  it("accepts minimal config with only gateway.url", () => {
    const result = parseNodeConfig({
      gateway: { url: "wss://gateway.example.com" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.gateway.url).toBe("wss://gateway.example.com");
      // Verify defaults are populated
      expect(result.value.gateway.reconnectBaseDelay).toBe(1_000);
      expect(result.value.gateway.maxRetries).toBe(10);
      expect(result.value.heartbeat.interval).toBe(30_000);
      expect(result.value.heartbeat.timeout).toBe(5_000);
      expect(result.value.discovery.enabled).toBe(true);
      expect(result.value.tools.builtins.filesystem).toBe(true);
      expect(result.value.tools.builtins.shell).toBe(true);
      expect(result.value.resources.maxAgents).toBe(50);
      expect(result.value.resources.memoryWarningPercent).toBe(80);
    }
  });

  it("accepts full config with overrides", () => {
    const result = parseNodeConfig({
      nodeId: "test-node-1",
      gateway: {
        url: "wss://gw.example.com",
        reconnectBaseDelay: 500,
        reconnectMaxDelay: 15_000,
        reconnectMultiplier: 1.5,
        reconnectJitter: 0.2,
        maxRetries: 5,
      },
      heartbeat: { interval: 10_000, timeout: 3_000 },
      discovery: { enabled: false, serviceType: "_custom._tcp" },
      tools: {
        directories: ["/usr/local/tools"],
        builtins: { filesystem: true, shell: false },
      },
      resources: {
        maxAgents: 10,
        memoryWarningPercent: 70,
        memoryEvictionPercent: 85,
        monitorInterval: 60_000,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodeId).toBe("test-node-1");
      expect(result.value.gateway.reconnectBaseDelay).toBe(500);
      expect(result.value.discovery.enabled).toBe(false);
      expect(result.value.tools.builtins.shell).toBe(false);
      expect(result.value.resources.maxAgents).toBe(10);
    }
  });

  it("rejects invalid gateway URL", () => {
    const result = parseNodeConfig({
      gateway: { url: "not-a-url" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects negative reconnect delay", () => {
    const result = parseNodeConfig({
      gateway: { url: "wss://gw.example.com", reconnectBaseDelay: -100 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects jitter outside 0-1 range", () => {
    const result = parseNodeConfig({
      gateway: { url: "wss://gw.example.com", reconnectJitter: 1.5 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects maxAgents of 0", () => {
    const result = parseNodeConfig({
      gateway: { url: "wss://gw.example.com" },
      resources: { maxAgents: 0 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects memoryWarningPercent > 100", () => {
    const result = parseNodeConfig({
      gateway: { url: "wss://gw.example.com" },
      resources: { memoryWarningPercent: 150 },
    });
    expect(result.ok).toBe(false);
  });
});
