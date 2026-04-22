/**
 * Dream preset stack — background memory consolidation middleware.
 *
 * Wires @koi/middleware-dream into the runtime so every session that
 * ends triggers the dream gate check. When the gate fires (≥5 sessions
 * since last dream, ≥24 h elapsed), consolidation runs in the background
 * using the same memory store and model adapter that the memory stack uses.
 *
 * Activation is a no-op when no model adapter is available (the middleware
 * requires a modelCall to drive consolidation prompts).
 */

import { mkdir } from "node:fs/promises";
import { createMemoryStore, resolveMemoryDir } from "@koi/memory-fs";
import { createDreamMiddleware } from "@koi/middleware-dream";
import type { PresetStack, StackContribution } from "../preset-stacks.js";

export const dreamStack: PresetStack = {
  id: "dream",
  description: "Background memory consolidation via @koi/middleware-dream (onSessionEnd gate)",
  activate: async (ctx): Promise<StackContribution> => {
    if (ctx.modelAdapter === undefined) {
      return { middleware: [], providers: [] };
    }

    const resolved = await resolveMemoryDir(ctx.cwd);
    const memoryDir = resolved.dir;
    await mkdir(memoryDir, { recursive: true });

    const store = createMemoryStore({ dir: memoryDir });

    const mw = createDreamMiddleware({
      memoryDir,
      listMemories: () => store.list(),
      writeMemory: async (input) => {
        await store.write(input);
      },
      deleteMemory: async (id) => {
        await store.delete(id);
      },
      modelCall: ctx.modelAdapter.complete,
    });

    return { middleware: [mw], providers: [] };
  },
};
