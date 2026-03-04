/**
 * @koi/gateway-stack — Full gateway bundle (Layer 3)
 *
 * Convenience package that wires @koi/gateway + @koi/gateway-canvas +
 * @koi/gateway-webhook into a single createGatewayStack() call.
 *
 * Usage:
 *   const stack = createGatewayStack(
 *     { gateway: {}, canvas: { port: 8081 }, webhook: { port: 8082 } },
 *     { transport, auth },
 *   );
 *   await stack.start(8080);
 */

export { createGatewayStack } from "./create-gateway-stack.js";
export type { GatewayStack, GatewayStackConfig, GatewayStackDeps } from "./types.js";
