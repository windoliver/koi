/**
 * Pattern registry — all 13 built-in secret detectors + default sensitive field names.
 */

import { markTrusted } from "../trusted.js";
import type { SecretPattern } from "../types.js";
import { createAnthropicDetector } from "./anthropic.js";
import { createAWSDetector } from "./aws.js";
import { createBase64DecodingDetector } from "./base64-decode.js";
import { createBasicAuthDetector } from "./basic-auth.js";
import { createBearerDetector } from "./bearer.js";
import { createCredentialURIDetector } from "./credential-uri.js";
import { createGenericSecretDetector } from "./generic-secret.js";
import { createGitHubDetector } from "./github.js";
import { createGoogleDetector } from "./google.js";
import { createJWTDetector } from "./jwt.js";
import { createOpenAIDetector } from "./openai.js";
import { createPEMDetector } from "./pem.js";
import { createSlackDetector } from "./slack.js";
import { createStripeDetector } from "./stripe.js";
import { createUrlDecodingDetector } from "./url-decode.js";

/** Create all 13 built-in secret pattern detectors. */
export function createAllSecretPatterns(): readonly SecretPattern[] {
  return [
    markTrusted(createJWTDetector()),
    markTrusted(createAWSDetector()),
    markTrusted(createOpenAIDetector()),
    markTrusted(createAnthropicDetector()),
    markTrusted(createGoogleDetector()),
    markTrusted(createGitHubDetector()),
    markTrusted(createSlackDetector()),
    markTrusted(createStripeDetector()),
    markTrusted(createPEMDetector()),
    markTrusted(createBearerDetector()),
    markTrusted(createBasicAuthDetector()),
    markTrusted(createCredentialURIDetector()),
    markTrusted(createGenericSecretDetector()),
  ];
}

/**
 * Create decoding detector wrappers (base64 + URL) around all 13 built-in patterns.
 *
 * These catch secrets that have been encoded to evade direct pattern matching —
 * e.g. a base64-encoded AWS key in a web_fetch URL argument.
 */
export function createDecodingDetectors(): readonly SecretPattern[] {
  const innerPatterns = createAllSecretPatterns();
  return [
    markTrusted(createBase64DecodingDetector(innerPatterns)),
    markTrusted(createUrlDecodingDetector(innerPatterns)),
  ];
}

/**
 * Default sensitive field names for field-name-based redaction.
 * Case-insensitive matching is applied by the field matcher.
 */
export const DEFAULT_SENSITIVE_FIELDS: readonly string[] = Object.freeze([
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "apikey",
  "authorization",
  "auth",
  "credential",
  "private_key",
  "privateKey",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "client_secret",
  "clientSecret",
  "session_id",
  "sessionId",
  "ssn",
  "credit_card",
  "creditCard",
  "cvv",
  "pin",
  "encryption_key",
  "encryptionKey",
  "connection_string",
  "connectionString",
  "aws_secret_access_key",
  "awsSecretAccessKey",
  "database_url",
  "databaseUrl",
]);
