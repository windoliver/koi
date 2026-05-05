import { startSandbox, stopSandbox } from "../src/index.js";

const r = await startSandbox({
  port: 2036,
  dataDir: "/tmp/nexus-e2e-real",
  command: ["uv", "run", "--directory", "/Users/tafeng/nexus", "nexusd"],
  healthTimeoutMs: 180_000,
});

if (!r.ok) {
  console.log("FAIL", r.error.code, r.error.message);
  process.exit(1);
}
console.log("OK", { baseUrl: r.value.baseUrl, pid: r.value.pid });
const probe = (await fetch(`${r.value.baseUrl}/health`).then((res) => res.json())) as {
  status?: string;
};
console.log("health:", JSON.stringify(probe));
const stop = await stopSandbox(r.value);
console.log("stop:", stop.ok ? "ok" : `fail ${"error" in stop ? stop.error.code : "?"}`);
