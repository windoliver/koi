export type Comparator<T> = (a: T, b: T) => number;

export interface Heap<T> {
  readonly insert: (item: T) => void;
  readonly extractMin: () => T | undefined;
  readonly peek: () => T | undefined;
  readonly size: () => number;
  readonly toArray: () => readonly T[];
  readonly remove: (predicate: (item: T) => boolean) => boolean;
}

export function createHeap<T>(compare: Comparator<T>): Heap<T> {
  const data: T[] = [];

  function swap(i: number, j: number): void {
    const tmp = data[i];
    data[i] = data[j] as T;
    data[j] = tmp as T;
  }

  function siftUp(i: number): void {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (compare(data[i] as T, data[parent] as T) >= 0) break;
      swap(i, parent);
      i = parent;
    }
  }

  function siftDown(i: number): void {
    const n = data.length;
    while (true) {
      let min = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && compare(data[l] as T, data[min] as T) < 0) min = l;
      if (r < n && compare(data[r] as T, data[min] as T) < 0) min = r;
      if (min === i) break;
      swap(i, min);
      i = min;
    }
  }

  return {
    insert(item: T): void {
      data.push(item);
      siftUp(data.length - 1);
    },
    extractMin(): T | undefined {
      if (data.length === 0) return undefined;
      const min = data[0] as T;
      const last = data.pop() as T;
      if (data.length > 0) {
        data[0] = last;
        siftDown(0);
      }
      return min;
    },
    peek(): T | undefined {
      return data[0];
    },
    size(): number {
      return data.length;
    },
    toArray(): readonly T[] {
      return [...data];
    },
    remove(predicate: (item: T) => boolean): boolean {
      const idx = data.findIndex(predicate);
      if (idx === -1) return false;
      data.splice(idx, 1);
      for (let i = Math.floor(data.length / 2) - 1; i >= 0; i--) siftDown(i);
      return true;
    },
  };
}
