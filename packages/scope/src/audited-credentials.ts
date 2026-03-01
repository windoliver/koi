/**
 * Audited credentials wrapper — emits AuditEntry on every credential access.
 *
 * Wraps a CredentialComponent and logs each `.get()` call via a fire-and-forget
 * AuditSink entry. Never logs the secret value — only the key name and whether
 * access was granted.
 */

import type { AuditEntry, AuditSink, CredentialComponent } from "@koi/core";
import { getExecutionContext } from "@koi/execution-context";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AuditedCredentialsConfig {
  readonly sink: AuditSink;
  readonly onError?: (error: unknown, entry: AuditEntry) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAuditedCredentials(
  component: CredentialComponent,
  config: AuditedCredentialsConfig,
): CredentialComponent {
  return {
    async get(key: string): Promise<string | undefined> {
      const ctx = getExecutionContext();
      const start = Date.now();

      const result = await component.get(key);

      const entry: AuditEntry = {
        timestamp: start,
        sessionId: ctx?.session.sessionId ?? "unknown",
        agentId: ctx?.session.agentId ?? "unknown",
        turnIndex: ctx?.turnIndex ?? -1,
        kind: "secret_access",
        durationMs: Date.now() - start,
        metadata: {
          credentialKey: key,
          granted: result !== undefined,
        },
      };

      // Fire-and-forget — sink errors must not block credential access
      void config.sink.log(entry).catch((error: unknown) => {
        if (config.onError !== undefined) {
          try {
            config.onError(error, entry);
          } catch (_) {
            // Last resort — onError itself failed; swallow to preserve fire-and-forget guarantee
          }
        }
      });

      return result;
    },
  };
}
