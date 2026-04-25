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

  function at(i: number): T {
    const v = data[i];
    if (v === undefined) throw new Error(`heap: index out of bounds: ${i}`);
    return v;
  }

  function swap(i: number, j: number): void {
    const a = at(i);
    const b = at(j);
    data[i] = b;
    data[j] = a;
  }

  function siftUp(i: number): void {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (compare(at(i), at(parent)) >= 0) break;
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
      if (l < n && compare(at(l), at(min)) < 0) min = l;
      if (r < n && compare(at(r), at(min)) < 0) min = r;
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
      const min = at(0);
      const last = data.pop();
      if (data.length > 0 && last !== undefined) {
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
