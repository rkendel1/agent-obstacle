/** Small, honest statistics: nothing is estimated; missing values are counted as not observed. */

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

export interface Distribution {
  observed: number;
  notObserved: number;
  min: number | null;
  median: number | null;
  p90: number | null;
  max: number | null;
  mean: number | null;
  total: number | null;
}

export function distribution(values: Array<number | null | undefined>): Distribution {
  const seen = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  const total = seen.reduce((a, b) => a + b, 0);
  return {
    observed: seen.length,
    notObserved: values.length - seen.length,
    min: seen.length ? seen[0]! : null,
    median: percentile(seen, 50),
    p90: percentile(seen, 90),
    max: seen.length ? seen[seen.length - 1]! : null,
    mean: seen.length ? total / seen.length : null,
    total: seen.length ? total : null,
  };
}
