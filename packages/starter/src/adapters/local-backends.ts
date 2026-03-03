/**
 * Local backend factory for offline Koi operation.
 *
 * Creates all 4 local backends (pay, audit, scratchpad, ipc) with sensible
 * defaults, so `koi start` works without a running Nexus server.
 */

import { createSqliteAuditSink } from "@koi/audit-sink-local";
import type { AuditSink, MailboxComponent, ScratchpadComponent } from "@koi/core";
import { agentGroupId, agentId } from "@koi/core";
import type { PayLedger } from "@koi/core/pay-ledger";
import { createLocalMailbox } from "@koi/ipc-local";
import { createLocalPayLedger } from "@koi/pay-local";
import { createLocalScratchpad } from "@koi/scratchpad-local";

/** Configuration for createLocalBackends. All fields are optional. */
export interface LocalBackendsConfig {
  /** Initial credit budget. Default: "1000". */
  readonly initialBudget?: string | undefined;
  /** Agent ID for the ledger. Default: "local-agent". */
  readonly agentId?: string | undefined;
  /** SQLite path for pay ledger. Default: ":memory:". */
  readonly payDbPath?: string | undefined;
  /** SQLite path for audit sink. Default: ":memory:". */
  readonly auditDbPath?: string | undefined;
  /** Agent group ID for scratchpad. Default: "local-group". */
  readonly groupId?: string | undefined;
  /** Author agent ID for scratchpad. Default: "local-agent". */
  readonly authorId?: string | undefined;
}

/** The 4 local backend instances returned by createLocalBackends. */
export interface LocalBackends {
  readonly payLedger: PayLedger;
  readonly auditSink: AuditSink;
  readonly scratchpad: ScratchpadComponent;
  readonly mailbox: MailboxComponent;
  /** Close all backends, releasing timers and resources. */
  readonly close: () => void;
}

/**
 * Create all 4 local backends with sensible defaults.
 *
 * Default config: in-memory pay (budget "1000"), in-memory audit (SQLite :memory:),
 * in-memory scratchpad, in-memory IPC.
 */
export function createLocalBackends(config?: LocalBackendsConfig): LocalBackends {
  const aid = config?.agentId ?? "local-agent";

  const payLedger = createLocalPayLedger({
    initialBudget: config?.initialBudget ?? "1000",
    agentId: aid,
    dbPath: config?.payDbPath,
  });

  const auditSinkInst = createSqliteAuditSink({
    dbPath: config?.auditDbPath ?? ":memory:",
  });

  const scratchpad = createLocalScratchpad({
    groupId: agentGroupId(config?.groupId ?? "local-group"),
    authorId: agentId(config?.authorId ?? aid),
  });

  const mailbox = createLocalMailbox({
    agentId: agentId(aid),
  });

  return {
    payLedger,
    auditSink: auditSinkInst,
    scratchpad,
    mailbox,
    close(): void {
      payLedger.close();
      auditSinkInst.close();
      scratchpad.close();
      mailbox.close();
    },
  };
}
