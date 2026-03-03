import { describe, expect, test } from "bun:test";
import { handleHealth } from "./health.js";

describe("handleHealth", () => {
  test("returns ok status with uptimeMs", async () => {
    const response = handleHealth();
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly data: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
    expect(typeof body.data.uptimeMs).toBe("number");
    expect(body.data.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  test("sets content-type to application/json", () => {
    const response = handleHealth();
    expect(response.headers.get("content-type")).toBe("application/json");
  });
});
