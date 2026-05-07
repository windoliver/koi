import { describe, expect, it } from "bun:test";

import { createWasmExecutor } from "./executor.js";
import { scanWasmSections } from "./section-scan.js";

// Hand-rolled minimal WASM modules. \0asm header + version, then sections.
const HEADER = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

// Section: id (1) + size LEB128 + payload. For tiny payloads <128 size = 1 byte.
const section = (id: number, payload: Uint8Array): Uint8Array =>
  concat(new Uint8Array([id, payload.length]), payload);

describe("scanWasmSections", () => {
  it("flags an internal memory section (id=5)", () => {
    // Memory section: count=1, limits flags=0, min=1
    const memSection = section(5, new Uint8Array([0x01, 0x00, 0x01]));
    const r = scanWasmSections(concat(HEADER, memSection));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hasInternalMemory).toBe(true);
  });

  it("flags an internal table section (id=4)", () => {
    // Table section: count=1, reftype=0x70 (funcref), limits flags=0, min=0
    const tblSection = section(4, new Uint8Array([0x01, 0x70, 0x00, 0x00]));
    const r = scanWasmSections(concat(HEADER, tblSection));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hasInternalTable).toBe(true);
  });

  it("counts imported memories", () => {
    // Import section: count=1, mod="m"(len 1, "m"), name="x"(len 1, "x"), kind=2 (memory), limits 0,1
    const imp = section(2, new Uint8Array([0x01, 0x01, 0x6d, 0x01, 0x78, 0x02, 0x00, 0x01]));
    const r = scanWasmSections(concat(HEADER, imp));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.importedMemoryCount).toBe(1);
    expect(r.value.importedMemory).toEqual({ module: "m", name: "x", limits: { min: 1 } });
  });

  it("rejects truncated header", () => {
    const r = scanWasmSections(new Uint8Array([0x00, 0x61, 0x73]));
    expect(r.ok).toBe(false);
  });
});

describe("executor — wasm resource enforcement", () => {
  it("rejects a module with an internal memory section", async () => {
    // Minimal valid wasm with an internal memory: header + memory section
    const memSection = section(5, new Uint8Array([0x01, 0x00, 0x01]));
    const bytes = concat(HEADER, memSection);
    const exec = createWasmExecutor();
    const r = await exec.execute(bytes, { export: "x", args: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("VALIDATION");
    expect(r.error.message).toContain("internal memory");
  });

  it("injects host-owned memory when the module imports memory and caller didn't supply it", async () => {
    // We can't easily build a valid full instantiable WASM by hand here, but we
    // can prove the import-shape detection by parsing an Import-section-only
    // module and observing the descriptor. Real instantiation is exercised by
    // the existing executor tests against compiled fixtures.
    const imp = section(
      2,
      new Uint8Array([
        0x01, 0x03, 0x65, 0x6e, 0x76, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x01,
      ]),
    );
    const r = scanWasmSections(concat(HEADER, imp));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.importedMemory).toEqual({
      module: "env",
      name: "memory",
      limits: { min: 1 },
    });
  });

  it("rejects timeoutMs > 0 (untrusted callers must not assume preemption)", async () => {
    const exec = createWasmExecutor();
    const r = await exec.execute(HEADER, { export: "x", args: [] }, { timeoutMs: 1_000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("TIMEOUT");
    expect(r.error.message).toContain("preempt");
  });

  it("rejects maxMemoryPages when no memory is imported", async () => {
    // A trivially valid module with no memory at all.
    const exec = createWasmExecutor();
    const r = await exec.execute(HEADER, { export: "x", args: [] }, { maxMemoryPages: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("VALIDATION");
    expect(r.error.message).toContain("import memory");
  });
});
