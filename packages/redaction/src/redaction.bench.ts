/**
 * @koi/redaction — Performance benchmarks.
 *
 * Run with: bun run src/redaction.bench.ts
 */

import { createRedactor } from "./redactor.js";

const r = createRedactor();

// --- Inputs ---

const CLEAN_1KB = "a".repeat(1024);
const CLEAN_10KB = "a".repeat(10_240);

const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123";
const aws = "AKIAIOSFODNN7EXAMPLE";
const bearer = "Bearer some-token-value";
const padding = "x".repeat(1024 - jwt.length - aws.length - bearer.length - 6);
const WITH_SECRETS_1KB = `${jwt} ${aws} ${bearer} ${padding}`;

const SHALLOW_OBJ = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [`key${i}`, `value-${i}`]),
);

const NESTED_OBJ = {
  level1: {
    password: "secret",
    level2: {
      data: "AKIAIOSFODNN7EXAMPLE",
      level3: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field${i}`, `val-${i}`])),
    },
    items: Array.from({ length: 20 }, (_, i) => ({ name: `item-${i}` })),
  },
};

// --- Benchmark runner ---

function benchmark(name: string, fn: () => void, iterations = 10_000): void {
  // Warm up
  for (let i = 0; i < 100; i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;

  const opsPerSec = ((iterations / elapsed) * 1_000).toFixed(0);
  const nsPerOp = ((elapsed / iterations) * 1_000_000).toFixed(0);
  console.log(`  ${name}: ${opsPerSec} ops/s (${nsPerOp} ns/op)`);
}

console.log("\n--- redactString: clean input ---");
benchmark("1KB clean", () => r.redactString(CLEAN_1KB));
benchmark("10KB clean", () => r.redactString(CLEAN_10KB));

console.log("\n--- redactString: with secrets ---");
benchmark("1KB with 3 secrets", () => r.redactString(WITH_SECRETS_1KB));

console.log("\n--- redactObject ---");
benchmark("shallow (10 keys, no secrets)", () => r.redactObject(SHALLOW_OBJ));
benchmark("nested (50 keys, 3 levels, 2 secrets)", () => r.redactObject(NESTED_OBJ));

console.log("\n--- createRedactor: construction ---");
benchmark("create with defaults", () => createRedactor(), 1_000);

console.log("");
