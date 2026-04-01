/**
 * CLI argument validation helper.
 *
 * Writes usage to stderr and exits with EXIT_CONFIG when a required
 * argument is missing. Reduces the repeated name-validation pattern
 * found in commands like `koi forge`.
 */

import { EXIT_CONFIG } from "@koi/shutdown";

/**
 * Asserts that a CLI argument is defined. If the value is `undefined`,
 * writes usage text to stderr and terminates with EXIT_CONFIG.
 *
 * @returns The value narrowed to `string` (never returns if undefined).
 */
export function expectArg(value: string | undefined, argName: string, usage: string): string {
  if (value !== undefined) {
    return value;
  }
  process.stderr.write(`Missing required argument: <${argName}>\n`);
  process.stderr.write(`Usage: ${usage}\n`);
  process.exit(EXIT_CONFIG);
}
