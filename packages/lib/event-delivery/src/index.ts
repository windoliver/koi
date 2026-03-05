/**
 * @koi/event-delivery — Shared subscription delivery chain for EventBackend (L0u).
 *
 * Manages subscriptions, serialized event delivery, retry, dead letter queue,
 * and replay. Backend implementations provide persistence callbacks.
 */
export type { DeliveryCallbacks, DeliveryConfig, DeliveryManager } from "./delivery-manager.js";
export { createDeliveryManager } from "./delivery-manager.js";
export type { ListenerSet, ListenerSetOptions } from "./listener-set.js";
export { createListenerSet } from "./listener-set.js";
