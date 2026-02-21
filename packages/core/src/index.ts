/**
 * @koi/core — Interfaces-only kernel (Layer 0)
 *
 * Zero runtime code. Zero dependencies.
 * Defines the 5 core contracts: Middleware, Message, Channel, Resolver, Assembly.
 */
export type KoiAgent = {
  readonly name: string;
};
