export interface GuardState {
  readonly destroyed: boolean;
  readonly check: (method: string) => void;
  readonly destroy: () => boolean;
}

export function createDestroyGuard(name: string = "resource"): GuardState {
  let destroyed = false;

  return {
    get destroyed() {
      return destroyed;
    },
    check(method: string) {
      if (destroyed) {
        throw new Error(`${name}: cannot call ${method}() after destroy()`);
      }
    },
    destroy() {
      if (destroyed) {
        return false;
      }
      destroyed = true;
      return true;
    },
  };
}
