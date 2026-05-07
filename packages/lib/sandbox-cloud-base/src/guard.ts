export interface GuardState {
  readonly destroyed: boolean;
  readonly destroy: () => boolean;
}

export function createDestroyGuard(): GuardState {
  let destroyed = false;

  return {
    get destroyed() {
      return destroyed;
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
