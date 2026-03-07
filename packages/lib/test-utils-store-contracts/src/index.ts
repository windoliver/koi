/**
 * @koi/test-utils-store-contracts — Store backend contract test suites for Koi.
 *
 * Provides reusable contract test suites for validating store backend
 * implementations against their L0 contracts.
 */

export type { AuditSinkContractOptions } from "./audit-sink-contract.js";
export { runAuditSinkContractTests } from "./audit-sink-contract.js";
export type { BrickRegistryContractOptions } from "./brick-registry-contract.js";
export { testBrickRegistryContract } from "./brick-registry-contract.js";
export { runEventBackendContractTests } from "./event-backend-contract.js";
export { runFileSystemBackendContractTests } from "./fs-backend-contract.js";
export { runNodeRegistryContractTests } from "./gateway-node-registry-contract.js";
export { runSessionStoreContractTests } from "./gateway-session-store-contract.js";
export { runSurfaceStoreContractTests } from "./gateway-surface-store-contract.js";
export { runMailboxContractTests } from "./mailbox-contract.js";
export type {
  MemoryRegistryForTest,
  MemoryRegistryTestContext,
} from "./memory-registry-contract.js";
export { runMemoryRegistryContractTests } from "./memory-registry-contract.js";
export type { NexusStoreAdapter } from "./nexus-store-contract.js";
export { runNexusStoreContractTests } from "./nexus-store-contract.js";
export { runPayLedgerContractTests } from "./pay-ledger-contract.js";
export {
  runScheduleStoreContractTests,
  runTaskStoreContractTests,
} from "./scheduler-store-contract.js";
export { runScratchpadContractTests } from "./scratchpad-contract.js";
export { runSessionPersistenceContractTests } from "./session-persistence-contract.js";
export type { SkillRegistryContractOptions } from "./skill-registry-contract.js";
export { testSkillRegistryContract } from "./skill-registry-contract.js";
export { runSnapshotChainStoreContractTests } from "./snapshot-chain-contract.js";
export { runForgeStoreContractTests } from "./store-contract.js";
export { runThreadStoreContractTests } from "./thread-store-contract.js";
export { makeTranscriptEntry, runSessionTranscriptContractTests } from "./transcript-contract.js";
export type { VersionIndexContractOptions } from "./version-index-contract.js";
export { testVersionIndexContract } from "./version-index-contract.js";
export { runWorkspaceBackendContractTests } from "./workspace-backend-contract.js";
