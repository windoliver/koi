import { describe, expect, test } from "bun:test";
import { makeTool } from "./__tests__/fixtures.js";
import { scanBrickWithVirusTotal } from "./virustotal.js";

describe("VirusTotal brick scanning", () => {
  test("submits tool implementation bytes to the injected VirusTotal client", async () => {
    const seen: string[] = [];
    const signal = await scanBrickWithVirusTotal(
      makeTool({ implementation: "export default 1;" }),
      {
        scan: async (content) => {
          seen.push(new TextDecoder().decode(content));
          return {
            id: "analysis-1",
            status: "completed",
            stats: { harmless: 8, malicious: 0, suspicious: 0, undetected: 1, timeout: 0 },
            scannedAt: 123,
          };
        },
      },
    );

    expect(seen).toEqual(["export default 1;"]);
    expect(signal.verdict).toBe("clean");
    expect(signal.passed).toBe(true);
  });

  test("submits skill content bytes to the injected VirusTotal client", async () => {
    const brick = {
      ...makeTool({ name: "skillish" }),
      kind: "skill" as const,
      content: "# Skill\n\n```ts\nconst x = 1;\n```",
    };
    const seen: string[] = [];
    const signal = await scanBrickWithVirusTotal(brick, {
      scan: async (content) => {
        seen.push(new TextDecoder().decode(content));
        return {
          id: "analysis-2",
          status: "completed",
          stats: { harmless: 0, malicious: 1, suspicious: 0, undetected: 0, timeout: 0 },
          scannedAt: 124,
        };
      },
    });

    expect(seen[0]).toContain("# Skill");
    expect(signal.verdict).toBe("malicious");
    expect(signal.passed).toBe(false);
  });
});
