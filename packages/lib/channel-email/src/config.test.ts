import { describe, expect, test } from "bun:test";
import { validateEmailConfig } from "./config.js";

const valid = {
  imap: { host: "imap.example.com", port: 993, user: "u", pass: "p", mailbox: "INBOX" },
  smtp: { host: "smtp.example.com", port: 587, user: "u", pass: "p", from: "bot@example.com" },
};

describe("validateEmailConfig", () => {
  test("accepts minimal valid config", () => {
    const r = validateEmailConfig(valid);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.imap.host).toBe("imap.example.com");
    expect(r.value.autoRetryAfterDataAck).toBe(false);
    expect(r.value.production).toBe(false);
  });

  test("rejects missing imap host", () => {
    const r = validateEmailConfig({ ...valid, imap: { ...valid.imap, host: "" } });
    expect(r.ok).toBe(false);
  });

  test("rejects port out of range", () => {
    const r = validateEmailConfig({ ...valid, imap: { ...valid.imap, port: 70000 } });
    expect(r.ok).toBe(false);
  });

  test("rejects malformed from address", () => {
    const r = validateEmailConfig({ ...valid, smtp: { ...valid.smtp, from: "not-an-email" } });
    expect(r.ok).toBe(false);
  });

  test("applies defaults for optional fields", () => {
    const r = validateEmailConfig({
      imap: { host: "h", port: 993, user: "u", pass: "p" },
      smtp: { host: "h", port: 587, user: "u", pass: "p", from: "a@b.c" },
    });
    if (!r.ok) throw new Error();
    expect(r.value.imap.mailbox).toBe("INBOX");
    expect(r.value.imap.tls).toBe(true);
    expect(r.value.smtp.tls).toBe(true);
    expect(r.value.pollInterval).toBe(60_000);
    expect(r.value.handlerTimeoutMs).toBe(300_000);
    expect(r.value.commitTtlMs).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("rejects non-positive pollInterval", () => {
    expect(validateEmailConfig({ ...valid, pollInterval: 0 }).ok).toBe(false);
    expect(validateEmailConfig({ ...valid, pollInterval: -1 }).ok).toBe(false);
  });
});
