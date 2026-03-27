import { describe, expect, it, mock } from "bun:test";
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
    // Force the dynamic import to fail so the catch path is exercised
    mock.module("bonjour", () => {
      throw new Error("Cannot find module 'bonjour'");
    });
    const { createDiscoveryService: create } = await import("./discovery.js");
    const svc = create({ enabled: true, serviceType: "_koi-agent._tcp" });
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
