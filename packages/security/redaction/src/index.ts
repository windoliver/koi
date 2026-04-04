/**
 * @koi/redaction — Structured log secret masking (L0u utility).
 *
 * Provides a compile-once redaction engine with 13 built-in secret pattern
 * detectors, field-name matching, and both structured + serialized APIs.
 */

// Config
export { DEFAULT_REDACTION_CONFIG, validateRedactionConfig } from "./config.js";
export { createAnthropicDetector } from "./patterns/anthropic.js";
export { createAWSDetector } from "./patterns/aws.js";
export { createBase64DecodingDetector } from "./patterns/base64-decode.js";
export { createBasicAuthDetector } from "./patterns/basic-auth.js";
export { createBearerDetector } from "./patterns/bearer.js";
export { createCredentialURIDetector } from "./patterns/credential-uri.js";
export { createGenericSecretDetector } from "./patterns/generic-secret.js";
export { createGitHubDetector } from "./patterns/github.js";
export { createGoogleDetector } from "./patterns/google.js";
// Pattern factories (for custom composition)
export {
  createAllSecretPatterns,
  createDecodingDetectors,
  DEFAULT_SENSITIVE_FIELDS,
} from "./patterns/index.js";
export { createJWTDetector } from "./patterns/jwt.js";
export { createOpenAIDetector } from "./patterns/openai.js";
export { createPEMDetector } from "./patterns/pem.js";
export { createSlackDetector } from "./patterns/slack.js";
export { createStripeDetector } from "./patterns/stripe.js";
export { createUrlDecodingDetector } from "./patterns/url-decode.js";
// Factory (main entry point)
export { createRedactor } from "./redactor.js";
// Types
export type {
  Censor,
  CensorStrategy,
  RedactionConfig,
  RedactObjectResult,
  Redactor,
  RedactStringResult,
  SecretMatch,
  SecretPattern,
} from "./types.js";
