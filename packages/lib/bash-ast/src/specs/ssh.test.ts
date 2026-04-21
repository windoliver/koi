import { describe, expect, test } from "bun:test";
import { specSsh } from "./ssh.js";

describe("specSsh — always refused", () => {
  test("plain ssh host", () => {
    const result = specSsh(["ssh", "user@host"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("unsupported-form");
    expect(result.detail).toMatch(/default ssh_config/);
  });

  test("ssh host with remote command — detail mentions remote command", () => {
    const result = specSsh(["ssh", "host", "rm -rf /"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/remote command/);
  });

  test("ssh -i KEY host — still refused (default config exposure)", () => {
    const result = specSsh(["ssh", "-i", "/key", "host"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/default ssh_config/);
  });

  test("ssh -o ProxyCommand=… → detail names -o", () => {
    const result = specSsh(["ssh", "-o", "ProxyCommand=nc evil 22", "host"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/-o/);
  });

  test("ssh -F /tmp/cfg host → detail names -F", () => {
    const result = specSsh(["ssh", "-F", "/tmp/cfg", "host"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/-F/);
  });

  test("ssh -J jump host → detail names -J", () => {
    const result = specSsh(["ssh", "-J", "jumphost", "host"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/-J/);
  });

  test("ssh -L 8080:internal:80 host → detail names port-forward", () => {
    const result = specSsh(["ssh", "-L", "8080:internal:80", "host"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/-L/);
  });

  test("ssh -D port host → detail names port-forward", () => {
    expect(specSsh(["ssh", "-D", "1080", "host"]).kind).toBe("refused");
  });

  test("ssh -R port:host:port host → detail names port-forward", () => {
    expect(specSsh(["ssh", "-R", "8080:internal:80", "host"]).kind).toBe("refused");
  });

  test("zero positionals", () => {
    expect(specSsh(["ssh"]).kind).toBe("refused");
  });

  test("never returns complete or partial — fuzz with permutations", () => {
    const cases = [
      ["ssh", "host"],
      ["ssh", "-p", "22", "host"],
      ["ssh", "-A", "host"],
      ["ssh", "host", "ls"],
      ["ssh", "-i", "k", "host", "whoami"],
    ];
    for (const argv of cases) {
      const result = specSsh(argv);
      expect(result.kind).toBe("refused");
    }
  });

  test("wrong command name", () => {
    expect(specSsh(["scp", "host:src", "."]).kind).toBe("refused");
  });
});
