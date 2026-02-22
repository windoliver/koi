import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { ScanContext } from "../types.js";
import { filesystemAbuseRule } from "./filesystem-abuse.js";

function scanCode(code: string): ReturnType<typeof filesystemAbuseRule.check> {
  const result = parseSync("input.ts", code, { sourceType: "module" });
  const ctx: ScanContext = {
    program: result.program,
    sourceText: code,
    filename: "input.ts",
  };
  return filesystemAbuseRule.check(ctx);
}

describe("filesystem-abuse rule", () => {
  describe("member-access delete calls", () => {
    test("detects fs.rmSync as CRITICAL", () => {
      const findings = scanCode('fs.rmSync("/tmp", { recursive: true });');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("filesystem-abuse:delete");
      expect(findings[0]?.severity).toBe("CRITICAL");
      expect(findings[0]?.confidence).toBe(0.9);
    });

    test("detects fs.unlinkSync as CRITICAL", () => {
      const findings = scanCode('fs.unlinkSync("/etc/passwd");');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("filesystem-abuse:delete");
      expect(findings[0]?.severity).toBe("CRITICAL");
    });

    test("detects fs.rm as CRITICAL", () => {
      const findings = scanCode('fs.rm("/tmp/data", { recursive: true }, () => {});');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe("CRITICAL");
    });

    test("detects fs.rmdirSync as CRITICAL", () => {
      const findings = scanCode('fs.rmdirSync("/tmp/dir");');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe("CRITICAL");
    });
  });

  describe("member-access write calls", () => {
    test("detects fs.writeFileSync as HIGH", () => {
      const findings = scanCode('fs.writeFileSync("/tmp/evil", data);');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("filesystem-abuse:write");
      expect(findings[0]?.severity).toBe("HIGH");
      expect(findings[0]?.confidence).toBe(0.85);
    });

    test("detects fs.appendFile as HIGH", () => {
      const findings = scanCode('fs.appendFile("/tmp/log", "data", () => {});');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe("HIGH");
    });

    test("detects fs.createWriteStream as HIGH", () => {
      const findings = scanCode('fs.createWriteStream("/tmp/output");');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe("HIGH");
    });
  });

  describe("member-access rename calls", () => {
    test("detects fs.renameSync as MEDIUM", () => {
      const findings = scanCode('fs.renameSync("a", "b");');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("filesystem-abuse:rename");
      expect(findings[0]?.severity).toBe("MEDIUM");
      expect(findings[0]?.confidence).toBe(0.6);
    });
  });

  describe("destructured calls", () => {
    test("detects destructured rmSync as HIGH", () => {
      const findings = scanCode('rmSync("path");');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("filesystem-abuse:delete");
      expect(findings[0]?.severity).toBe("HIGH");
      expect(findings[0]?.confidence).toBe(0.7);
    });

    test("detects destructured unlinkSync as HIGH", () => {
      const findings = scanCode('unlinkSync("/tmp/file");');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe("HIGH");
    });

    test("detects destructured writeFileSync as MEDIUM", () => {
      const findings = scanCode('writeFileSync("/tmp/out", "data");');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("filesystem-abuse:write");
      expect(findings[0]?.severity).toBe("MEDIUM");
      expect(findings[0]?.confidence).toBe(0.6);
    });

    test("detects destructured renameSync as LOW", () => {
      const findings = scanCode('renameSync("a.db", "/tmp/stolen.db");');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("filesystem-abuse:rename");
      expect(findings[0]?.severity).toBe("LOW");
      expect(findings[0]?.confidence).toBe(0.5);
    });
  });

  describe("dynamic import detection", () => {
    test("detects import('fs') as LOW", () => {
      const findings = scanCode('const m = import("fs");');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("filesystem-abuse:fs-import");
      expect(findings[0]?.severity).toBe("LOW");
      expect(findings[0]?.confidence).toBe(0.4);
    });

    test("detects import('fs/promises') as LOW", () => {
      const findings = scanCode('const m = import("fs/promises");');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("filesystem-abuse:fs-import");
      expect(findings[0]?.severity).toBe("LOW");
    });

    test("detects import('node:fs') as LOW", () => {
      const findings = scanCode('const m = import("node:fs");');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("filesystem-abuse:fs-import");
      expect(findings[0]?.severity).toBe("LOW");
    });

    test("detects import('node:fs/promises') as LOW", () => {
      const findings = scanCode('const m = import("node:fs/promises");');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("filesystem-abuse:fs-import");
      expect(findings[0]?.severity).toBe("LOW");
    });
  });

  describe("benign patterns", () => {
    test("string containing fs.writeFile is not flagged", () => {
      const findings = scanCode('console.log("fs.writeFile");');
      expect(findings).toHaveLength(0);
    });

    test("plain math is not flagged", () => {
      const findings = scanCode("const x = 1 + 2;");
      expect(findings).toHaveLength(0);
    });

    test("non-fs member calls are not flagged", () => {
      const findings = scanCode('myfs.writeFile("path", data);');
      expect(findings).toHaveLength(0);
    });

    test("fs.readFile is not flagged", () => {
      const findings = scanCode('fs.readFile("path", () => {});');
      expect(findings).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    test("handles empty code", () => {
      const findings = scanCode("");
      expect(findings).toHaveLength(0);
    });

    test("detects multiple fs operations in same file", () => {
      const findings = scanCode('fs.rmSync("/tmp");\nfs.writeFileSync("/tmp/out", "data");');
      expect(findings).toHaveLength(2);
      expect(findings.some((f) => f.rule === "filesystem-abuse:delete")).toBe(true);
      expect(findings.some((f) => f.rule === "filesystem-abuse:write")).toBe(true);
    });
  });
});
