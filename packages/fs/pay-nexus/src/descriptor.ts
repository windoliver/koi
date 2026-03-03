/**
 * BrickDescriptor for @koi/pay-nexus.
 *
 * Enables manifest auto-resolution: validates Nexus pay config,
 * then creates the PayLedger backed by the Nexus pay API.
 */

import type { KoiError, Result } from "@koi/core/errors";
import type { PayLedger } from "@koi/core/pay-ledger";
import type { BrickDescriptor } from "@koi/resolve";
import { validateRequiredDescriptorOptions } from "@koi/resolve";
import { validatePayLedgerConfig } from "./config.js";
import { createNexusPayLedger } from "./ledger.js";

function validatePayNexusOptions(input: unknown): Result<Record<string, unknown>, KoiError> {
  const base = validateRequiredDescriptorOptions(input, "Pay Nexus");
  if (!base.ok) return base;

  const result = validatePayLedgerConfig(input);
  if (!result.ok) return result;

  return { ok: true, value: base.value };
}

export const payNexusDescriptor: BrickDescriptor<PayLedger> = {
  kind: "middleware",
  name: "@koi/pay-nexus",
  aliases: ["pay-nexus"],
  description: "Nexus-backed persistent credit ledger for budget enforcement",
  optionsValidator: validatePayNexusOptions,
  factory(options): PayLedger {
    const result = validatePayLedgerConfig(options);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return createNexusPayLedger(result.value);
  },
};
