import { serializeSharedResource } from "./workspace.js";

export type VectorClock = Readonly<Record<string, number>>;
export type VectorClockOrder = "equal" | "before" | "after" | "concurrent";

export interface ResourceWrite {
  readonly resource: string;
  readonly vectorClock: VectorClock;
}

export function compareVectorClock(left: VectorClock, right: VectorClock): VectorClockOrder {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  let leftBefore = false;
  let rightBefore = false;

  for (const key of keys) {
    const leftValue = left[key] ?? 0;
    const rightValue = right[key] ?? 0;

    if (leftValue < rightValue) {
      leftBefore = true;
    } else if (leftValue > rightValue) {
      rightBefore = true;
    }

    if (leftBefore && rightBefore) {
      return "concurrent";
    }
  }

  if (!leftBefore && !rightBefore) {
    return "equal";
  }

  return leftBefore ? "before" : "after";
}

export function detectWriteConflict(left: ResourceWrite, right: ResourceWrite): boolean {
  const leftResource = serializeSharedResource(left.resource);
  const rightResource = serializeSharedResource(right.resource);

  if (leftResource.length === 0 || rightResource.length === 0) {
    return false;
  }

  return (
    leftResource === rightResource &&
    compareVectorClock(left.vectorClock, right.vectorClock) === "concurrent"
  );
}
