#!/usr/bin/env bun
/**
 * In-process mock Nexus HTTP server for HA validation.
 *
 * Implements the JSON-RPC contract the rest of the Koi codebase calls:
 * `read`, `write`, `delete`, `list` (matches fs-nexus, audit-sink-nexus,
 * permissions-nexus, gateway-nexus, runtime/trajectory). The production
 * Nexus image exposes only batch variants (`read_bulk`, `write_batch`,
 * `delete_batch`); aliasing the bare names is a separate, project-wide
 * migration. This mock intentionally implements the bare names so HA
 * behavior can be verified end-to-end without coupling to that work.
 *
 * Env: PORT (default 19600)
 */

const PORT = Number.parseInt(process.env.PORT ?? "19600", 10);
const HOSTNAME = "127.0.0.1";

const store = new Map<string, string>();

interface RpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const ok = (id: unknown, result: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "Content-Type": "application/json" },
  });

const fail = (id: unknown, code: number, message: string, data?: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } }), {
    headers: { "Content-Type": "application/json" },
  });

const NOT_FOUND = -32000;

const server = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  fetch: async (req): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", entries: store.size }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!url.pathname.startsWith("/api/nfs/")) {
      return new Response("not found", { status: 404 });
    }
    let rpc: RpcRequest;
    try {
      rpc = (await req.json()) as RpcRequest;
    } catch {
      return fail(null, -32700, "parse error");
    }
    const params = (rpc.params ?? {}) as Record<string, unknown>;
    const path = typeof params.path === "string" ? params.path : undefined;
    switch (rpc.method) {
      case "read": {
        if (path === undefined) return fail(rpc.id, -32602, "missing path");
        const v = store.get(path);
        if (v === undefined) return fail(rpc.id, NOT_FOUND, "not found");
        const data = Buffer.from(v, "utf-8").toString("base64");
        return ok(rpc.id, { __type__: "bytes", data });
      }
      case "write": {
        if (path === undefined) return fail(rpc.id, -32602, "missing path");
        const content = params.content;
        let text: string | undefined;
        if (typeof content === "string") text = content;
        else if (
          typeof content === "object" &&
          content !== null &&
          (content as { __type__?: string }).__type__ === "bytes" &&
          typeof (content as { data?: unknown }).data === "string"
        ) {
          text = Buffer.from((content as { data: string }).data, "base64").toString("utf-8");
        }
        if (text === undefined) return fail(rpc.id, -32602, "bad content");
        store.set(path, text);
        return ok(rpc.id, null);
      }
      case "delete": {
        if (path === undefined) return fail(rpc.id, -32602, "missing path");
        const existed = store.delete(path);
        if (!existed) return fail(rpc.id, NOT_FOUND, "not found");
        return ok(rpc.id, null);
      }
      case "list": {
        if (path === undefined) return fail(rpc.id, -32602, "missing path");
        const prefix = path.endsWith("/") ? path : `${path}/`;
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
        return ok(rpc.id, keys);
      }
      default:
        return fail(rpc.id, -32601, `unknown method: ${rpc.method}`);
    }
  },
});

console.log(
  JSON.stringify({
    kind: "mock_nexus_started",
    url: `http://${HOSTNAME}:${server.port}`,
  }),
);

const shutdown = (signal: string): void => {
  console.log(JSON.stringify({ kind: "mock_nexus_stopping", signal, entries: store.size }));
  server.stop();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await new Promise<void>(() => {});
