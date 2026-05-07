/**
 * Runtime-fence target catalogue — the list of provider-mutable globals that
 * a class-A edge handler is forbidden to reach. Used by:
 *
 *   - The edge-adapter shim's runtime fence (installed before operator code runs).
 *   - The edge-adapter's recursive AST scan over the operator module graph.
 *   - The CI gate that asserts the catalogue and the fence are in sync.
 *
 * v1 class A = side-effect-free. Any path that can reach the network, persistent
 * storage, another isolate, or arbitrary WASM compilation is NOT class A.
 *
 * Adding a target here is a normative-contract change — the spec section
 * "Class-A workload restriction" must be updated atomically.
 */

/** Top-level globals (and member chains) banned in class-A handler code. */
export const RUNTIME_FENCE_TARGETS: readonly string[] = Object.freeze([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "Worker",
  "SharedWorker",
  "MessageChannel",
  "WebAssembly.instantiate",
  "WebAssembly.instantiateStreaming",
  "WebAssembly.compile",
  "WebAssembly.compileStreaming",
  "caches",
  "navigator.sendBeacon",
  "EventSource",
  "BroadcastChannel",
]);

/**
 * Identifier-only top-level forms of the targets above. The AST scan rejects
 * any reference to one of these names in operator-authored modules; the
 * runtime fence overwrites them with throwing accessors.
 */
export const RUNTIME_FENCE_TOP_LEVEL_IDENTIFIERS: readonly string[] = Object.freeze([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "Worker",
  "SharedWorker",
  "MessageChannel",
  "caches",
  "EventSource",
  "BroadcastChannel",
]);
