/**
 * /agents/<id>/middleware — list attached middleware.
 */

import type { Agent, KoiMiddleware, ProcEntry } from "@koi/core";

export function createMiddlewareEntry(agent: Agent): ProcEntry {
  return {
    read: () => {
      const mw = agent.query<KoiMiddleware>("middleware:");
      return [...mw.entries()].map(([token, middleware]) => ({
        token: token as string,
        name: middleware.name,
      }));
    },
    list: () => {
      const mw = agent.query<KoiMiddleware>("middleware:");
      return [...mw.keys()].map((t) => t as string);
    },
  };
}
