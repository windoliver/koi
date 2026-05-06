import { describe, expect, it } from "bun:test";

import { createWasmExecutor } from "./executor.js";

// Hand-assembled WASM module: exports "add" :: (i32, i32) -> i32 returning a+b.
// Generated from `(module (func (export "add") (param i32 i32) (result i32)
//   local.get 0 local.get 1 i32.add))`.
const ADD_MODULE_BYTES = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00, // magic + version
  0x01,
  0x07,
  0x01,
  0x60,
  0x02,
  0x7f,
  0x7f,
  0x01,
  0x7f, // type: (i32 i32)->i32
  0x03,
  0x02,
  0x01,
  0x00, // func
  0x07,
  0x07,
  0x01,
  0x03,
  0x61,
  0x64,
  0x64,
  0x00,
  0x00, // export "add"
  0x0a,
  0x09,
  0x01,
  0x07,
  0x00,
  0x20,
  0x00,
  0x20,
  0x01,
  0x6a,
  0x0b, // body
]);

describe("createWasmExecutor", () => {
  it("executes an exported function and returns its return value", async () => {
    const executor = createWasmExecutor();
    const result = await executor.execute(ADD_MODULE_BYTES, { export: "add", args: [2, 3] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output).toBe(5);
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects bytes that are not a wasm module", async () => {
    const executor = createWasmExecutor();
    const result = await executor.execute(new Uint8Array([1, 2, 3, 4]), {
      export: "add",
      args: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_BYTES");
  });

  it("rejects a missing export with MISSING_EXPORT", async () => {
    const executor = createWasmExecutor();
    const result = await executor.execute(ADD_MODULE_BYTES, { export: "nope", args: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_EXPORT");
  });

  it("caches compiled modules across invocations (smoke check via repeat call)", async () => {
    const executor = createWasmExecutor();
    const r1 = await executor.execute(ADD_MODULE_BYTES, { export: "add", args: [10, 20] });
    const r2 = await executor.execute(ADD_MODULE_BYTES, { export: "add", args: [10, 20] });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value.output).toBe(30);
    expect(r2.value.output).toBe(30);
  });
});
