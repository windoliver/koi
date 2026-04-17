/**
 * Child-process worker for cross-process upsert tests.
 *
 * Usage: bun run <this-file> <dir> <name> <type> <force> <goSignal>
 *
 * Waits for the go-signal file to be removed, then calls store.upsert()
 * and writes the result action to stdout as JSON.
 */

import { stat } from "node:fs/promises";
import { createMemoryStore } from "../store.js";

const [dir, name, type, forceStr, goSignal] = process.argv.slice(2);

if (!dir || !name || !type || !forceStr || !goSignal) {
  process.stderr.write("Usage: bun run worker.ts <dir> <name> <type> <force> <goSignal>\n");
  process.exit(1);
}

const force = forceStr === "true";

// Spin-wait for the go signal file to disappear (parent removes it).
const waitForGo = async (): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    try {
      await stat(goSignal);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      return;
    }
  }
  throw new Error("Timed out waiting for go signal");
};

const run = async (): Promise<void> => {
  const store = createMemoryStore({ dir });
  await waitForGo();

  const result = await store.upsert(
    {
      name,
      description: `Cross-process test record ${name}`,
      type: type as "user",
      content: `Content uniquely about ${name}: ${name} ${name} ${name} ${name} ${name} ${name} ${name} ${name} details.`,
    },
    { force },
  );

  process.stdout.write(`${JSON.stringify({ action: result.action })}\n`);
};

run().catch((e: unknown) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
