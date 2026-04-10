#!/usr/bin/env bun
/**
 * Refresh packages/lib/bash-ast/vendor/tree-sitter-bash.wasm from the
 * @vscode/tree-sitter-wasm package.
 *
 * Run manually when upgrading the bash grammar. The vendored .wasm file is
 * committed to git as a binary asset so the package has no transitive
 * dependency on a ~22 MB grammar bundle at runtime.
 *
 * Usage: bun run refresh-grammar
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GRAMMAR_SOURCE = "@vscode/tree-sitter-wasm@0.3.1";
const TARGET = new URL("../vendor/tree-sitter-bash.wasm", import.meta.url).pathname;

const workdir = await mkdtemp(join(tmpdir(), "koi-grammar-refresh-"));
try {
  await writeFile(join(workdir, "package.json"), "{}\n");

  console.log(`Installing ${GRAMMAR_SOURCE} in ${workdir}...`);
  const install = Bun.spawn({
    cmd: ["bun", "add", "--no-save", GRAMMAR_SOURCE],
    cwd: workdir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const installCode = await install.exited;
  if (installCode !== 0) {
    throw new Error(`bun add failed with exit code ${installCode}`);
  }

  const src = join(workdir, "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm");
  const bytes = await Bun.file(src).arrayBuffer();
  await writeFile(TARGET, new Uint8Array(bytes));

  console.log(`Wrote ${TARGET} (${bytes.byteLength.toLocaleString()} bytes)`);
} finally {
  await rm(workdir, { recursive: true, force: true });
}
