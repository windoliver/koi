import { describe, expect, test } from "bun:test";
import { type SmtpTransport, sendViaSmtp } from "./platform-send.js";

const fake = (impl: SmtpTransport["sendMail"]): SmtpTransport => ({
  sendMail: impl,
});

const env = {
  from: "a@b",
  to: ["c@d"] as readonly string[],
  subject: "s",
  text: "t",
  headers: {} as Readonly<Record<string, string>>,
};

describe("sendViaSmtp", () => {
  test("250 OK -> post-data ok", async () => {
    const r = await sendViaSmtp(
      fake(async () => ({ accepted: ["c@d"], rejected: [], response: "250 OK" })),
      env,
    );
    expect(r).toEqual({ phase: "post-data", ok: true });
  });

  test("ECONNREFUSED -> pre-data fail", async () => {
    const err = Object.assign(new Error("nope"), { code: "ECONNREFUSED" });
    const r = await sendViaSmtp(
      fake(async () => {
        throw err;
      }),
      env,
    );
    expect(r.phase).toBe("pre-data");
    expect(r.ok).toBe(false);
  });

  test("EAUTH -> pre-data fail", async () => {
    const err = Object.assign(new Error("auth"), { code: "EAUTH" });
    const r = await sendViaSmtp(
      fake(async () => {
        throw err;
      }),
      env,
    );
    expect(r.phase).toBe("pre-data");
    expect(r.ok).toBe(false);
  });

  test("post-data error preserves classification", async () => {
    const err = Object.assign(new Error("dropped"), {
      code: "EPROTOCOL",
      responseCode: 451,
      response: "451 dropped after DATA",
    });
    const r = await sendViaSmtp(
      fake(async () => {
        throw err;
      }),
      env,
    );
    expect(r.phase).toBe("post-data");
    expect(r.ok).toBe(false);
  });

  test("rejected recipient -> post-data fail", async () => {
    const r = await sendViaSmtp(
      fake(async () => ({ accepted: [], rejected: ["c@d"], response: "550" })),
      env,
    );
    expect(r).toMatchObject({ phase: "post-data", ok: false });
  });

  test("non-Error throw -> post-data fail with stringified message", async () => {
    const r = await sendViaSmtp(
      fake(async () => {
        throw "weird";
      }),
      env,
    );
    expect(r.phase).toBe("post-data");
    expect(r.ok).toBe(false);
  });
});
