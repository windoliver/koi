import { describe, expect, it } from "bun:test";
import { mapNexusHttpError } from "./http-errors.js";

describe("mapNexusHttpError", () => {
  it("maps 400 to VALIDATION", () => {
    const error = mapNexusHttpError(400, "bad query");
    expect(error.code).toBe("VALIDATION");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("bad query");
  });

  it("maps 401 to PERMISSION", () => {
    const error = mapNexusHttpError(401, "unauthorized");
    expect(error.code).toBe("PERMISSION");
    expect(error.retryable).toBe(false);
  });

  it("maps 403 to PERMISSION", () => {
    const error = mapNexusHttpError(403, "forbidden");
    expect(error.code).toBe("PERMISSION");
    expect(error.retryable).toBe(false);
  });

  it("maps 404 to NOT_FOUND", () => {
    const error = mapNexusHttpError(404, "not found");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.retryable).toBe(false);
  });

  it("maps 429 to RATE_LIMIT", () => {
    const error = mapNexusHttpError(429, "too many requests");
    expect(error.code).toBe("RATE_LIMIT");
    expect(error.retryable).toBe(true);
  });

  it("maps 500 to retryable EXTERNAL", () => {
    const error = mapNexusHttpError(500, "internal error");
    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(true);
  });

  it("maps 502 to retryable EXTERNAL", () => {
    const error = mapNexusHttpError(502, "bad gateway");
    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(true);
  });

  it("maps unknown status to non-retryable EXTERNAL", () => {
    const error = mapNexusHttpError(418, "i'm a teapot");
    expect(error.code).toBe("EXTERNAL");
    expect(error.retryable).toBe(false);
  });
});
