/**
 * @koi/middleware-pii — Detect and redact PII in agent I/O (Layer 2)
 *
 * Supports 7 built-in detectors (email, credit card, IP, MAC, URL, SSN, phone)
 * and 4 strategies (redact, mask, hash, block). Custom detectors
 * can be added via config.
 */

export { validatePIIConfig } from "./config.js";
export {
  createAllDetectors,
  createCreditCardDetector,
  createEmailDetector,
  createIPDetector,
  createMACDetector,
  createPhoneDetector,
  createSSNDetector,
  createURLDetector,
} from "./detectors.js";
export { createPIIMiddleware } from "./pii-middleware.js";
export type { PIIConfig, PIIDetector, PIIMatch, PIIScope, PIIStrategy } from "./types.js";
