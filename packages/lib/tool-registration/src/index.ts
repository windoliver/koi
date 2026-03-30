/**
 * @koi/tool-registration — Shared factory for self-registering L2 tool packages (L0u).
 *
 * Converts ToolRegistration descriptors into ComponentProviders, handling
 * availability gating, timeout, skip reporting, and tool construction.
 *
 * Depends on @koi/core only.
 */

export { createProviderFromRegistration } from "./create-provider.js";
