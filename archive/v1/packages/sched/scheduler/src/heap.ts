/**
 * Generic min-heap (priority queue) backed by a flat array.
 *
 * Comparator returns negative if a should come before b.
 */

export interface MinHeap<T> {
  readonly insert: (item: T) => void;
  readonly extractMin: () => T | undefined;
  readonly peek: () => T | undefined;
  readonly size: () => number;
  readonly toArray: () => readonly T[];
  readonly remove: (predicate: (item: T) => boolean) => boolean;
}

export function createMinHeap<T>(compare: (a: T, b: T) => number): MinHeap<T> {
  const data: T[] = []; // internal mutable array for heap operations

  function swap(i: number, j: number): void {
    const a = data[i];
    const b = data[j];
    if (a === undefined || b === undefined) return;
    data[i] = b;
    data[j] = a;
  }

  function siftUp(index: number): void {
    let i = index; // let: moves up toward root
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const current = data[i];
      const parentItem = data[parent];
      if (current !== undefined && parentItem !== undefined && compare(current, parentItem) < 0) {
        swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  function siftDown(index: number): void {
    let i = index; // let: moves down toward leaves
    const len = data.length;
    while (true) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i; // let: tracks smallest of parent/children

      const leftItem = data[left];
      const smallestItem = data[smallest];
      if (
        left < len &&
        leftItem !== undefined &&
        smallestItem !== undefined &&
        compare(leftItem, smallestItem) < 0
      ) {
        smallest = left;
      }
      const rightItem = data[right];
      const smallestAfterLeft = data[smallest];
      if (
        right < len &&
        rightItem !== undefined &&
        smallestAfterLeft !== undefined &&
        compare(rightItem, smallestAfterLeft) < 0
      ) {
        smallest = right;
      }
      if (smallest === i) break;
      swap(i, smallest);
      i = smallest;
    }
  }

  return {
    insert: (item) => {
      data.push(item);
      siftUp(data.length - 1);
    },

    extractMin: () => {
      if (data.length === 0) return undefined;
      if (data.length === 1) return data.pop();
      const min = data[0];
      const last = data.pop();
      if (min === undefined || last === undefined) return undefined;
      data[0] = last;
      siftDown(0);
      return min;
    },

    peek: () => (data.length > 0 ? data[0] : undefined),

    size: () => data.length,

    toArray: () => [...data],

    remove: (predicate) => {
      const index = data.findIndex(predicate);
      if (index === -1) return false;
      if (index === data.length - 1) {
        data.pop();
        return true;
      }
      const popped = data.pop();
      if (popped === undefined) return false;
      data[index] = popped;
      siftDown(index);
      siftUp(index);
      return true;
    },
  };
}
