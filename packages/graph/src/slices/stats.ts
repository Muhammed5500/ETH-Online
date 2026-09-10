/**
 * The arithmetic the slices share.
 *
 * Pure, and tested on its own, because these are the numbers an agent reasons
 * over. A concentration ratio that is quietly wrong produces a confident
 * report, and a confident wrong report moves the market price and takes money
 * off other agents. The scoring rule cannot tell the difference between a lie
 * and a bug.
 *
 * Every function returns `null` rather than a plausible-looking default when
 * there is nothing to compute. `0` for "no data" would read as "no
 * concentration", which is the opposite of unknown.
 */

/** Sum, ignoring nulls. Returns null when nothing was summable. */
export function sum(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0);
}

export function mean(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

export function median(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (present.length === 0) return null;
  const mid = Math.floor(present.length / 2);
  return present.length % 2 === 0 ? (present[mid - 1]! + present[mid]!) / 2 : present[mid]!;
}

/**
 * Ratio with the denominator checked.
 *
 * A zero denominator is `null`, not `Infinity`. `Infinity` survives JSON as
 * `null` anyway, but it survives arithmetic as `Infinity` and poisons every
 * average it touches on the way.
 */
export function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null) return null;
  if (denominator === 0) return null;
  return numerator / denominator;
}

/**
 * What share of the total sits in the largest `n` entries.
 *
 * The plainest concentration measure there is, and the one that answers "is
 * this a market or is this one address". Returns null for an empty or
 * zero-valued set: nothing to be concentrated in.
 */
export function topNShare(values: readonly number[], n: number): number | null {
  if (values.length === 0 || n <= 0) return null;
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const top = [...values].sort((a, b) => b - a).slice(0, n);
  return top.reduce((a, b) => a + b, 0) / total;
}

/**
 * Herfindahl-Hirschman index over shares, in [0, 1].
 *
 * 1 means one participant holds everything; 1/n means n equal participants.
 * Included alongside `topNShare` because they disagree in a useful way: a
 * hundred equal wash accounts have a low top-10 share and a low HHI, while ten
 * whales have a high top-10 share and a high HHI. Seeing both apart is worth
 * more than either alone.
 */
export function herfindahl(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return values.reduce((acc, v) => acc + (v / total) ** 2, 0);
}

/**
 * Coefficient of variation: standard deviation over mean.
 *
 * The bot detector. Human activity is bursty and its inter-arrival times vary
 * a lot, so CV sits near or above 1. A script firing on a timer produces a CV
 * near 0. A CV of 0.05 on a thousand swaps is not a market.
 *
 * Population standard deviation, not sample: these are all the events in the
 * window, not a draw from a larger pool.
 */
export function coefficientOfVariation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  if (m === 0) return null;
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(m);
}

/** Gaps between consecutive timestamps, sorted ascending first. */
export function interArrivalGaps(timestamps: readonly number[]): number[] {
  if (timestamps.length < 2) return [];
  const sorted = [...timestamps].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]! - sorted[i - 1]!);
  return gaps;
}

/**
 * Share of entries that appear exactly once.
 *
 * High one-shot share plus growing user counts is the shape of addresses being
 * created rather than customers arriving.
 */
export function oneShotShare(keys: readonly string[]): number | null {
  if (keys.length === 0) return null;
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  let ones = 0;
  for (const c of counts.values()) if (c === 1) ones++;
  return ones / counts.size;
}

export function uniqueCount(keys: readonly string[]): number {
  return new Set(keys).size;
}

/** Totals per key, for turning a list of events into per-address amounts. */
export function sumByKey(
  entries: readonly { key: string; value: number }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) out.set(e.key, (out.get(e.key) ?? 0) + e.value);
  return out;
}

/**
 * Where `value` sits among `population`, in [0, 1].
 *
 * Used by the comparative slice, and the reason it can say "this protocol's
 * turnover is higher than every peer" rather than "turnover is 14.2", which
 * means nothing without somewhere to stand.
 */
export function percentileRank(value: number | null, population: readonly number[]): number | null {
  if (value === null || population.length === 0) return null;
  const below = population.filter((p) => p < value).length;
  const equal = population.filter((p) => p === value).length;
  return (below + equal / 2) / population.length;
}

/**
 * Share of amounts that land on a suspiciously round number.
 *
 * Genuine swap sizes are messy — they come out of slippage, gas budgets and
 * whatever was in the wallet. Scripted volume is written by a human choosing
 * numbers, and humans choose round ones.
 *
 * Deliberately loose: this is one weak signal among several, and it is
 * reported as such rather than used as proof of anything.
 */
export function roundNumberShare(amounts: readonly number[]): number | null {
  if (amounts.length === 0) return null;
  const isRound = (x: number): boolean => {
    if (x <= 0) return false;
    const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(x)) - 1);
    return Math.abs(x / magnitude - Math.round(x / magnitude)) < 1e-9;
  };
  return amounts.filter(isRound).length / amounts.length;
}

/**
 * How unevenly events fall across the hours of the day, in [0, 1].
 *
 * Normalised so 0 means perfectly spread over all 24 hours and 1 means every
 * event in a single hour. Real usage follows waking hours across time zones
 * and lands in between; a cron job lands at one.
 */
export function hourConcentration(timestampsSeconds: readonly number[]): number | null {
  if (timestampsSeconds.length === 0) return null;
  const buckets = new Array<number>(24).fill(0);
  for (const t of timestampsSeconds) {
    const hour = Math.floor(t / 3600) % 24;
    buckets[hour] = (buckets[hour] ?? 0) + 1;
  }
  const hhi = herfindahl(buckets);
  if (hhi === null) return null;
  const floor = 1 / 24;
  return Math.max(0, (hhi - floor) / (1 - floor));
}
