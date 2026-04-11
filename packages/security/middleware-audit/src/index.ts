/**
 * @koi/middleware-audit — Security-grade audit logging middleware.
 */

export type { AuditMiddleware } from "./audit.js";
export { createAuditMiddleware } from "./audit.js";
export type { AuditMiddlewareConfig } from "./config.js";
export { validateAuditConfig } from "./config.js";
export type { SigningHandle } from "./signing.js";
export { createEphemeralSigningHandle, GENESIS_HASH, verifyEntrySignature } from "./signing.js";
