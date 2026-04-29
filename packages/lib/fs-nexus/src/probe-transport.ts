/**
 * Disposable local-bridge probe transport.
 *
 * Spawns a fresh short-lived bridge subprocess, exercises `version` + the
 * configured policy `read` paths through `transport.call(...)` (so spawn,
 * IPC handshake, line parsing, and notification routing are all validated),
 * then closes itself.
 *
 * Sealed-capability pattern: spawn config is captured in the closure and
 * never exposed on the returned transport object — eliminates credential
 * leak risk via inspection of the long-lived runtime transport.
 */

import type { KoiError, Result } from "@koi/core";
import {
  DEFAULT_PROBE_PATHS,
  extractReadContent,
  HEALTH_DEADLINE_MS,
  type HealthCapableNexusTransport,
  type NexusHealth,
  type NexusHealthOptions,
} from "@koi/nexus-client";
import { createLocalTransport, type LocalTransportConfig } from "./local-transport.js";

/**
 * Factory for a disposable probe transport. Caller passes `spawnConfig`
 * once; the returned function constructs a fresh probe each invocation.
 *
 * @example
 *   const probeFactory = createNexusProbeFactory({ mountUri, pythonPath, env });
 *   const probe = await probeFactory();
 *   const result = await probe.health();
 *   probe.close();
 */
export function createNexusProbeFactory(
  spawnConfig: LocalTransportConfig,
): () => Promise<HealthCapableNexusTransport> {
  return async (): Promise<HealthCapableNexusTransport> => {
    const inner = await createLocalTransport(spawnConfig);

    async function health(opts?: NexusHealthOptions): Promise<Result<NexusHealth, KoiError>> {
      const probeDeadlineMs = opts?.probeDeadlineMs ?? HEALTH_DEADLINE_MS;
      const readPaths = opts?.readPaths ?? DEFAULT_PROBE_PATHS;
      const start = performance.now();

      const versionResult = await inner.call<unknown>(
        "version",
        {},
        { deadlineMs: probeDeadlineMs, nonInteractive: true },
      );
      if (!versionResult.ok) return { ok: false, error: versionResult.error };
      const version =
        typeof versionResult.value === "string"
          ? versionResult.value
          : JSON.stringify(versionResult.value);

      if (readPaths.length === 0) {
        return {
          ok: true,
          value: {
            status: "version-only",
            version,
            latencyMs: Math.round(performance.now() - start),
            probed: ["version"],
          },
        };
      }

      const probed: string[] = ["version"];
      const notFound: string[] = [];
      for (const path of readPaths) {
        const r = await inner.call<unknown>(
          "read",
          { path },
          { deadlineMs: probeDeadlineMs, nonInteractive: true },
        );
        if (!r.ok) {
          if (r.error.code === "NOT_FOUND") {
            notFound.push(path);
            probed.push(`read:${path}`);
            continue;
          }
          return { ok: false, error: r.error };
        }
        const extracted = extractReadContent(r.value);
        if (!extracted.ok) return { ok: false, error: extracted.error };
        probed.push(`read:${path}`);
      }

      const latencyMs = Math.round(performance.now() - start);
      if (notFound.length > 0) {
        return {
          ok: true,
          value: { status: "missing-paths", version, latencyMs, probed, notFound },
        };
      }
      return { ok: true, value: { status: "ok", version, latencyMs, probed } };
    }

    return {
      kind: "probe",
      call: inner.call,
      health,
      close: inner.close,
    };
  };
}
