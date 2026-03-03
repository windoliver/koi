import { describe, expect, test } from "bun:test";
import * as auditSinkLocal from "../index.js";

describe("@koi/audit-sink-local API surface", () => {
  test("exports createSqliteAuditSink", () => {
    expect(typeof auditSinkLocal.createSqliteAuditSink).toBe("function");
  });

  test("exports createNdjsonAuditSink", () => {
    expect(typeof auditSinkLocal.createNdjsonAuditSink).toBe("function");
  });

  test("no unexpected exports", () => {
    const keys = Object.keys(auditSinkLocal).sort();
    expect(keys).toEqual(["createNdjsonAuditSink", "createSqliteAuditSink"]);
  });
});
