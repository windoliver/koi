import { createDashboardApi } from "@koi/dashboard-api";
import { createPaginatedFixtureSource, type FixtureControls } from "./fixture-source.js";

export interface FixtureServer extends FixtureControls {
  readonly url: string;
  readonly authToken: string;
  readonly close: () => Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const controls = createPaginatedFixtureSource();
  const authToken = "fixture-test-token";
  const api = createDashboardApi({
    source: controls.source,
    authToken,
    defaultLimit: 25,
    maxLimit: 50,
    sseFlushMs: 5,
  });

  const server = Bun.serve({
    port: 0,
    fetch(request): Promise<Response> | Response {
      // dashboard-api routes don't include the /api prefix; strip it before dispatch.
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        const inner = new Request(
          `${url.protocol}//${url.host}${url.pathname.slice(4)}${url.search}`,
          request,
        );
        return api.fetch(inner);
      }
      return api.fetch(request);
    },
  });

  return {
    ...controls,
    url: `http://localhost:${server.port}`,
    authToken,
    close: async () => {
      server.stop(true);
    },
  };
}
