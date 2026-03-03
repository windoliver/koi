/**
 * @koi/pay-nexus — Nexus-backed credit ledger (Layer 2)
 *
 * Persistent PayLedger implementation that talks to the Nexus pay API
 * (TigerBeetle + PostgreSQL). Pass the resulting PayLedger directly
 * to @koi/middleware-pay's `ledger` config field.
 */

export type { NexusPayLedgerConfig } from "./config.js";
export { validatePayLedgerConfig } from "./config.js";
export { payNexusDescriptor } from "./descriptor.js";
export { createNexusPayLedger } from "./ledger.js";
