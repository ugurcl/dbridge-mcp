import type { IndexHealth } from "./types.js";

export function markDuplicates(indexes: IndexHealth[]): void {
  const seen = new Map<string, IndexHealth>();
  for (const index of indexes) {
    if (index.columns.length === 0) {
      continue;
    }
    const key = `${index.table}::${index.columns.join(",").toLowerCase()}`;
    const first = seen.get(key);
    if (first) {
      index.issues.push(`duplicate: covers the same columns as "${first.index}"`);
    } else {
      seen.set(key, index);
    }
  }
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function capLimit(limit: number, max: number): number {
  return Math.min(Math.max(Math.floor(limit), 1), max);
}
