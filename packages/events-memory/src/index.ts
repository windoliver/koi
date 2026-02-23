/**
 * @koi/events-memory — In-memory EventBackend (Layer 2)
 *
 * Provides an in-memory implementation of the EventBackend contract
 * with event replay, named subscriptions, and dead letter queue.
 */
export { createInMemoryEventBackend } from "./memory-backend.js";
