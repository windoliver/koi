import { describe, expect, it, spyOn } from "bun:test";

import { createWasmExecutor } from "./executor.js";

// (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
const ADD_MODULE_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01,
  0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09,
  0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

// (module (func (export "boom") unreachable))
const TRAP_MODULE_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02,
  0x01, 0x00, 0x07, 0x08, 0x01, 0x04, 0x62, 0x6f, 0x6f, 0x6d, 0x00, 0x00, 0x0a, 0x05, 0x01, 0x03,
  0x00, 0x00, 0x0b,
]);

// (module (func)) — has a function but does NOT export it.
const NO_EXPORTS_MODULE_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02,
  0x01, 0x00, 0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
]);

// (module (import "env" "foo" (func))) — declares an import that callers must supply.
const NEEDS_IMPORT_MODULE_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x02, 0x0b,
  0x01, 0x03, 0x65, 0x6e, 0x76, 0x03, 0x66, 0x6f, 0x6f, 0x00, 0x00,
]);

describe("createWasmExecutor — corner cases", () => {
  it("classifies magic-valid but structurally-invalid bytes as VALIDATION (not INVALID_BYTES)", async () => {
    // Magic + version + 4 garbage bytes — passes hasWasmMagic but fails WebAssembly.validate.
    const bad = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff,
    ]);
    const r = await createWasmExecutor().execute(bad, { export: "x", args: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("VALIDATION");
  });

  it("surfaces a runtime trap as TRAP with the underlying error in `cause`", async () => {
    const r = await createWasmExecutor().execute(TRAP_MODULE_BYTES, { export: "boom", args: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("TRAP");
    expect(r.error.cause).toBeDefined();
  });

  it("returns MISSING_EXPORT when the module has no exports at all", async () => {
    const r = await createWasmExecutor().execute(NO_EXPORTS_MODULE_BYTES, {
      export: "anything",
      args: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MISSING_EXPORT");
  });

  it("returns INSTANTIATE_FAILED when caller fails to supply a declared import", async () => {
    const r = await createWasmExecutor().execute(NEEDS_IMPORT_MODULE_BYTES, {
      export: "x",
      args: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INSTANTIATE_FAILED");
  });

  it("compiles each unique byte sequence at most once across repeated execute() calls", async () => {
    const executor = createWasmExecutor();
    const compileSpy = spyOn(WebAssembly, "compile");
    const startCount = compileSpy.mock.calls.length;
    // Use a fresh clone of the bytes so the SHA-256 cache key is determined by content, not identity.
    const bytes = new Uint8Array(ADD_MODULE_BYTES);
    await executor.execute(bytes, { export: "add", args: [1, 1] });
    await executor.execute(new Uint8Array(ADD_MODULE_BYTES), { export: "add", args: [2, 2] });
    await executor.execute(new Uint8Array(ADD_MODULE_BYTES), { export: "add", args: [3, 3] });
    const callsAdded = compileSpy.mock.calls.length - startCount;
    expect(callsAdded).toBeLessThanOrEqual(1);
    compileSpy.mockRestore();
  });

  it("handles concurrent execute() calls without corrupting the cache", async () => {
    const executor = createWasmExecutor();
    const calls = Array.from({ length: 16 }, (_, i) =>
      executor.execute(new Uint8Array(ADD_MODULE_BYTES), { export: "add", args: [i, i] }),
    );
    const results = await Promise.all(calls);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      expect(r?.ok).toBe(true);
      if (!r?.ok) continue;
      expect(r.value.output).toBe(i + i);
    }
  });
});
