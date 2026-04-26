import { describe, expect, it } from "bun:test";
import type { JsonObject } from "@koi/core";
import { applyAliases } from "./aliases.js";
import type { AliasSpec } from "./types.js";

const aliases: readonly AliasSpec[] = [
  { kind: "tool_call", field: "tool", from: "bash_exec", to: "bash" },
  { kind: "tool_call", field: "tool", from: "shell_exec", to: "bash" },
];

describe("applyAliases", () => {
  it("rewrites a matching field", () => {
    const p = applyAliases(
      "tool_call",
      { tool: "bash_exec", cmd: "ls" } satisfies JsonObject,
      aliases,
    );
    expect(p).toEqual({ tool: "bash", cmd: "ls" });
  });

  it("passes through when kind does not match", () => {
    const p = applyAliases("model_call", { tool: "bash_exec" } satisfies JsonObject, aliases);
    expect(p).toEqual({ tool: "bash_exec" });
  });

  it("passes through when field value does not match", () => {
    const p = applyAliases("tool_call", { tool: "python" } satisfies JsonObject, aliases);
    expect(p).toEqual({ tool: "python" });
  });

  it("passes through when the field is absent", () => {
    const p = applyAliases("tool_call", { cmd: "ls" } satisfies JsonObject, aliases);
    expect(p).toEqual({ cmd: "ls" });
  });

  it("applies multiple specs in order (first match wins)", () => {
    const p = applyAliases("tool_call", { tool: "shell_exec" } satisfies JsonObject, aliases);
    expect(p).toEqual({ tool: "bash" });
  });

  it("returns a fresh object — does not mutate input", () => {
    const input = { tool: "bash_exec", cmd: "ls" } satisfies JsonObject;
    applyAliases("tool_call", input, aliases);
    expect(input).toEqual({ tool: "bash_exec", cmd: "ls" });
  });

  it("returns input reference when no aliases are provided", () => {
    const input = { tool: "bash" } satisfies JsonObject;
    expect(applyAliases("tool_call", input, [])).toBe(input);
  });
});
