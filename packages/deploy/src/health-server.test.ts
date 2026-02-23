import { afterEach, describe, expect, it } from "bun:test";
import { createHealthHandler, createHealthServer } from "./health-server.js";

// ---------------------------------------------------------------------------
// Unit tests — handler function
// ---------------------------------------------------------------------------

describe("createHealthHandler", () => {
  it("returns 200 ok for /health", async () => {
    const handler = createHealthHandler();
    const res = await handler(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns Connection: close header", async () => {
    const handler = createHealthHandler();
    const res = await handler(new Request("http://localhost/health"));
    expect(res.headers.get("Connection")).toBe("close");
  });

  it("returns Cache-Control: no-store", async () => {
    const handler = createHealthHandler();
    const res = await handler(new Request("http://localhost/health"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 200 ready for /health/ready when no onReady callback", async () => {
    const handler = createHealthHandler();
    const res = await handler(new Request("http://localhost/health/ready"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ready");
  });

  it("returns 200 when onReady returns true", async () => {
    const handler = createHealthHandler(() => true);
    const res = await handler(new Request("http://localhost/health/ready"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ready");
  });

  it("returns 503 when onReady returns false", async () => {
    const handler = createHealthHandler(() => false);
    const res = await handler(new Request("http://localhost/health/ready"));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("not ready");
  });

  it("returns 503 when async onReady returns false", async () => {
    const handler = createHealthHandler(async () => false);
    const res = await handler(new Request("http://localhost/health/ready"));
    expect(res.status).toBe(503);
  });

  it("returns 404 for unknown paths", async () => {
    const handler = createHealthHandler();
    const res = await handler(new Request("http://localhost/unknown"));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Integration test — ephemeral server
// ---------------------------------------------------------------------------

describe("createHealthServer (integration)", () => {
  let server: ReturnType<typeof createHealthServer> | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  it("starts on port 0 and responds to /health", async () => {
    server = createHealthServer({ port: 0 });
    const info = await server.start();
    expect(info.port).toBeGreaterThan(0);

    const res = await fetch(`${info.url}health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("reports readiness via /health/ready", async () => {
    let ready = false;
    server = createHealthServer({
      port: 0,
      onReady: () => ready,
    });
    const info = await server.start();

    // Not ready yet
    const res1 = await fetch(`${info.url}health/ready`);
    expect(res1.status).toBe(503);

    // Now ready
    ready = true;
    const res2 = await fetch(`${info.url}health/ready`);
    expect(res2.status).toBe(200);
  });
});
