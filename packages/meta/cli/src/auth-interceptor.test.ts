import { describe, expect, it, mock } from "bun:test";
import { createAuthInterceptor, isOAuthRedirectUrl } from "./auth-interceptor.js";

describe("isOAuthRedirectUrl", () => {
  it("matches http://localhost:8080/callback?code=abc&state=xyz", () => {
    expect(isOAuthRedirectUrl("http://localhost:8080/callback?code=abc&state=xyz")).toBe(true);
  });

  it("matches with a different port", () => {
    expect(isOAuthRedirectUrl("http://localhost:3000/callback?code=xyz")).toBe(true);
  });

  it("matches http://127.0.0.1:8080/callback?code=abc", () => {
    expect(isOAuthRedirectUrl("http://127.0.0.1:8080/callback?code=abc")).toBe(true);
  });

  it("matches without port", () => {
    expect(isOAuthRedirectUrl("http://localhost/callback?code=abc")).toBe(true);
  });

  it("rejects a normal user message", () => {
    expect(isOAuthRedirectUrl("what files are in my drive?")).toBe(false);
  });

  it("rejects a non-callback URL", () => {
    expect(isOAuthRedirectUrl("https://example.com/page")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isOAuthRedirectUrl("")).toBe(false);
  });

  it("handles leading/trailing whitespace (trimmed before matching)", () => {
    expect(isOAuthRedirectUrl("  http://localhost:8080/callback?code=abc  ")).toBe(true);
  });
});

describe("createAuthInterceptor", () => {
  it("calls submitAuthCode when redirect URL is detected with correct correlationId", () => {
    const submitAuthCode = mock(() => undefined);
    const intercept = createAuthInterceptor({ submitAuthCode });
    const url = "http://localhost:8080/callback?code=abc&state=xyz";
    intercept(url, "corr-123");
    expect(submitAuthCode).toHaveBeenCalledTimes(1);
    expect(submitAuthCode).toHaveBeenCalledWith(url, "corr-123");
  });

  it("returns { intercepted: true } for redirect URLs", () => {
    const submitAuthCode = mock(() => undefined);
    const intercept = createAuthInterceptor({ submitAuthCode });
    const result = intercept("http://localhost:8080/callback?code=abc", "corr-1");
    expect(result).toEqual({ intercepted: true });
  });

  it("returns { intercepted: false } for normal messages and does NOT call submitAuthCode", () => {
    const submitAuthCode = mock(() => undefined);
    const intercept = createAuthInterceptor({ submitAuthCode });
    const result = intercept("what files are in my drive?", undefined);
    expect(result).toEqual({ intercepted: false });
    expect(submitAuthCode).not.toHaveBeenCalled();
  });

  it("passes trimmed URL to submitAuthCode", () => {
    const submitAuthCode = mock(() => undefined);
    const intercept = createAuthInterceptor({ submitAuthCode });
    const url = "http://localhost:8080/callback?code=abc";
    intercept(`  ${url}  `, "corr-2");
    expect(submitAuthCode).toHaveBeenCalledWith(url, "corr-2");
  });

  it("works when correlationId is undefined", () => {
    const submitAuthCode = mock(() => undefined);
    const intercept = createAuthInterceptor({ submitAuthCode });
    const url = "http://127.0.0.1:9000/callback?code=def";
    const result = intercept(url, undefined);
    expect(result).toEqual({ intercepted: true });
    expect(submitAuthCode).toHaveBeenCalledWith(url, undefined);
  });
});
