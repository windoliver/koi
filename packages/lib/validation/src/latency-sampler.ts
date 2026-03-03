/**
 * Bounded sorted-sample buffer for percentile estimation.
 *
 * Pure functions — no I/O, no side effects. Operates on LatencySampler
 * from @koi/core. Uses reservoir sampling when the sample buffer is full,
 * keeping samples sorted for O(1) percentile lookups.
 */

import type { LatencySampler } from "@koi/core";

const DEFAULT_CAP = 200;

/** Creates an empty latency sampler with the given capacity. */
export function createLatencySampler(cap: number = DEFAULT_CAP): LatencySampler {
  return { samples: [], count: 0, cap: Math.max(1, Math.round(cap)) };
}

/**
 * Inserts a value into a sorted array at the correct position (binary search).
 * Returns a new array — never mutates the input.
 */
function sortedInsert(arr: readonly number[], value: number): readonly number[] {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midVal = arr[mid];
    if (midVal !== undefined && midVal < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return [...arr.slice(0, lo), value, ...arr.slice(lo)];
}

/**
 * Replaces a value in a sorted array: removes the old value and inserts the new one.
 * Returns a new array — never mutates the input.
 */
function sortedReplace(
  arr: readonly number[],
  oldValue: number,
  newValue: number,
): readonly number[] {
  // Remove old value (find first occurrence via binary search)
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midVal = arr[mid];
    if (midVal !== undefined && midVal < oldValue) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const without = [...arr.slice(0, lo), ...arr.slice(lo + 1)];
  return sortedInsert(without, newValue);
}

/**
 * Records a latency sample. Below cap: always inserts (sorted).
 * At/above cap: reservoir sampling — replaces a random existing sample
 * with probability `cap / count`, maintaining statistical representativeness.
 */
export function recordLatency(sampler: LatencySampler, valueMs: number): LatencySampler {
  const newCount = sampler.count + 1;

  if (sampler.samples.length < sampler.cap) {
    // Below capacity — always insert (sorted)
    return {
      samples: sortedInsert(sampler.samples, valueMs),
      count: newCount,
      cap: sampler.cap,
    };
  }

  // Reservoir sampling: replace with probability cap/count
  const replaceIndex = Math.floor(Math.random() * newCount);
  if (replaceIndex >= sampler.cap) {
    // Don't replace — just increment count
    return { samples: sampler.samples, count: newCount, cap: sampler.cap };
  }

  // Replace the chosen sample, maintaining sort order
  const oldValue = sampler.samples[replaceIndex];
  if (oldValue === undefined) {
    return { samples: sampler.samples, count: newCount, cap: sampler.cap };
  }
  return {
    samples: sortedReplace(sampler.samples, oldValue, valueMs),
    count: newCount,
    cap: sampler.cap,
  };
}

/**
 * Computes a percentile from the sorted sample buffer.
 * Returns undefined if the buffer is empty.
 *
 * @param p - Percentile in [0, 1], e.g. 0.99 for P99.
 */
export function computePercentile(sampler: LatencySampler, p: number): number | undefined {
  if (sampler.samples.length === 0) {
    return undefined;
  }
  const clampedP = Math.max(0, Math.min(1, p));
  const index = Math.min(Math.floor(clampedP * sampler.samples.length), sampler.samples.length - 1);
  return sampler.samples[index];
}

/**
 * Merges two samplers into one. The resulting sampler has capacity
 * equal to the max of both inputs. Samples are merged and truncated
 * to fit within the capacity using uniform random selection.
 */
export function mergeSamplers(a: LatencySampler, b: LatencySampler): LatencySampler {
  const cap = Math.max(a.cap, b.cap);
  const totalCount = a.count + b.count;

  // Merge both sorted arrays
  const merged: number[] = [];
  let ai = 0;
  let bi = 0;
  while (ai < a.samples.length && bi < b.samples.length) {
    const av = a.samples[ai];
    const bv = b.samples[bi];
    if (av !== undefined && (bv === undefined || av <= bv)) {
      merged.push(av);
      ai++;
    } else if (bv !== undefined) {
      merged.push(bv);
      bi++;
    }
  }
  while (ai < a.samples.length) {
    const v = a.samples[ai];
    if (v !== undefined) merged.push(v);
    ai++;
  }
  while (bi < b.samples.length) {
    const v = b.samples[bi];
    if (v !== undefined) merged.push(v);
    bi++;
  }

  // If within cap, return as-is
  if (merged.length <= cap) {
    return { samples: merged, count: totalCount, cap };
  }

  // Downsample: pick cap elements uniformly spaced from the sorted merged array
  const downsampled: number[] = [];
  for (let i = 0; i < cap; i++) {
    const idx = Math.floor((i * merged.length) / cap);
    const v = merged[idx];
    if (v !== undefined) downsampled.push(v);
  }

  return { samples: downsampled, count: totalCount, cap };
}
