import { describe, expect, it } from "bun:test";
import { createDiscoveryService } from "./discovery.js";

let bonjourAvailable = false;
try {
  await import("bonjour" as string);
  bonjourAvailable = true;
} catch {
  bonjourAvailable = false;
}

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
    await svc.publish({
      name: "test-node",
      type: "_koi-agent._tcp",
      port: 3000,
      txt: { nodeId: "n1", version: "0.0.0", capacity: "10" },
    });
    if (bonjourAvailable) {
      // bonjour is installed — publish succeeds
      expect(svc.isPublished()).toBe(true);
      await svc.unpublish();
      expect(svc.isPublished()).toBe(false);
    } else {
      // bonjour is not installed — publish fails silently
      expect(svc.isPublished()).toBe(false);
    }
  });
});
