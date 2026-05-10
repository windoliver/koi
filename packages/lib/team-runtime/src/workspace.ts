export function serializeSharedResource(resource: string): string {
  return resource.trim();
}

export function serializeSharedResources(
  resources: readonly string[] | undefined,
): readonly string[] {
  if (resources === undefined) {
    return [];
  }

  return [
    ...new Set(resources.map(serializeSharedResource).filter((resource) => resource.length > 0)),
  ].sort();
}

export interface ResourceSerializer {
  readonly acquire: (resource: string) => boolean;
  readonly release: (resource: string) => void;
  readonly isLocked: (resource: string) => boolean;
  readonly snapshot: () => readonly string[];
}

export function createResourceSerializer(
  initialResources: readonly string[] = [],
): ResourceSerializer {
  const locks = new Set(serializeSharedResources(initialResources));

  return {
    acquire(resource) {
      const key = serializeSharedResource(resource);
      if (key.length === 0 || locks.has(key)) return false;
      locks.add(key);
      return true;
    },
    release(resource) {
      locks.delete(serializeSharedResource(resource));
    },
    isLocked(resource) {
      return locks.has(serializeSharedResource(resource));
    },
    snapshot() {
      return [...locks].sort();
    },
  };
}
