/**
 * resolveTemporalOrWarn — lazy-load Temporal client and create admin adapter.
 *
 * When --temporal-url is provided, dynamically imports @temporalio/client,
 * connects to the server, and creates a TemporalAdminAdapter whose views
 * and commands are passed to the admin panel bridge.
 *
 * Uses untyped dynamic import because @temporalio/client is an optional
 * peer dependency — the CLI does not declare it in package.json. If the
 * package is missing at runtime, the catch block warns and returns undefined.
 *
 * Returns undefined when no URL is provided or connection fails.
 */

import type { TemporalAdminClientLike } from "@koi/dashboard-api";
import { createTemporalAdminAdapter } from "@koi/dashboard-api";

export interface TemporalAdminResult {
  readonly views: ReturnType<typeof createTemporalAdminAdapter>["views"];
  readonly commands: ReturnType<typeof createTemporalAdminAdapter>["commands"];
  readonly dispose: () => Promise<void>;
}

export async function resolveTemporalOrWarn(
  temporalUrl: string | undefined,
  verbose: boolean,
): Promise<TemporalAdminResult | undefined> {
  if (temporalUrl === undefined) return undefined;

  try {
    // Dynamic import to avoid loading native Temporal SDK unless needed.
    // Untyped import — @temporalio/client is an optional peer dependency.
    // Use variable to prevent TypeScript from resolving the module specifier.
    const modName = "@temporalio/client";
    const temporalMod = (await import(modName)) as {
      readonly Client: new (opts: { readonly connection: unknown }) => unknown;
      readonly Connection: {
        readonly connect: (opts: { readonly address: string }) => Promise<{
          readonly close: () => Promise<void>;
        }>;
      };
    };

    const connection = await temporalMod.Connection.connect({ address: temporalUrl });
    const client = new temporalMod.Client({ connection });

    if (verbose) {
      process.stderr.write(`Temporal: connected to ${temporalUrl}\n`);
    }

    // The @temporalio/client Client satisfies TemporalAdminClientLike structurally
    const adapter = createTemporalAdminAdapter(client as TemporalAdminClientLike, {
      serverAddress: temporalUrl,
    });

    return {
      views: adapter.views,
      commands: adapter.commands,
      dispose: async () => {
        await connection.close();
      },
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`warn: temporal connection failed (${temporalUrl}): ${msg}\n`);
    return undefined;
  }
}
