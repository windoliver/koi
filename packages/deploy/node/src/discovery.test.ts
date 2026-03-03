import { describe, expect, it } from "bun:test";
import { createDiscoveryService } from "./discovery.js";

describe("DiscoveryService", () => {
  it("starts unpublished", () => {
    const svc = createDiscoveryService({ enabled: true, serviceType: "_koi-agent._tcp" });
    expect(svc.isPublished()).toBe(false);
  });

  it("handles publish when disabled", async () => {
    const svc = createDiscoveryService({ enabled: false, serviceType: "_koi-agent._tcp" });
    await svc.publish({
      name: "test-node",
      type: "_koi-agent._tcp",
      port: 3000,
      txt: { nodeId: "n1", version: "0.0.0", capacity: "10" },
    });
    // Should remain unpublished when disabled
    expect(svc.isPublished()).toBe(false);
  });

  it("handles unpublish when not published", async () => {
    const svc = createDiscoveryService({ enabled: true, serviceType: "_koi-agent._tcp" });
    // Should not throw
    await svc.unpublish();
    expect(svc.isPublished()).toBe(false);
  });

  it("handles publish gracefully when bonjour is not available", async () => {
    const svc = createDiscoveryService({ enabled: true, serviceType: "_koi-agent._tcp" });
    // bonjour is not installed as a real dependency — publish will fail silently
    await svc.publish({
      name: "test-node",
      type: "_koi-agent._tcp",
      port: 3000,
      txt: { nodeId: "n1", version: "0.0.0", capacity: "10" },
    });
    // Stays unpublished since bonjour is not available
    expect(svc.isPublished()).toBe(false);
  });
});
