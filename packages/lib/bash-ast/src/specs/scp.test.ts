import { describe, expect, test } from "bun:test";
import { specScp } from "./scp.js";

describe("specScp — always refused", () => {
  test("plain scp host:path local form", () => {
    const result = specScp(["scp", "host:src", "."]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("unsupported-form");
    expect(result.detail).toMatch(/default ssh_config/);
  });

  test("plain scp local to host", () => {
    const result = specScp(["scp", "src.txt", "host:/dst"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/default ssh_config/);
  });

  test("with -o flag — detail names the flag", () => {
    const result = specScp(["scp", "-o", "ProxyCommand=nc evil 22", "src", "host:dst"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/-o/);
  });

  test("with -F flag", () => {
    const result = specScp(["scp", "-F", "/tmp/cfg", "src", "host:dst"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/-F/);
  });

  test("with -J flag", () => {
    const result = specScp(["scp", "-J", "jumphost", "src", "host:dst"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/-J/);
  });

  test("never returns complete or partial — fuzz with permutations", () => {
    const cases = [
      ["scp"],
      ["scp", "src"],
      ["scp", "-r", "src", "host:dst"],
      ["scp", "-i", "/key", "src", "host:dst"],
      ["scp", "-P", "2222", "src", "host:dst"],
    ];
    for (const argv of cases) {
      const result = specScp(argv);
      expect(result.kind).toBe("refused");
    }
  });

  test("wrong command name", () => {
    expect(specScp(["ssh", "host"]).kind).toBe("refused");
  });
});
