/**
 * Slice arithmetic tests.
 *
 * These are the numbers an agent reasons over, and the scoring rule cannot
 * tell a bug from a lie: a concentration ratio that is quietly wrong produces
 * a confident report, and a confident wrong report moves the price and takes
 * money off the other agents.
 *
 * The recurring assertion is that "no data" comes back as `null` and never as
 * a plausible-looking zero. `0` for an unknown concentration reads as "no
 * concentration", which is the opposite of what is true.
 */
import { describe, expect, it } from 'vitest';
import {
  coefficientOfVariation,
  herfindahl,
  hourConcentration,
  interArrivalGaps,
  mean,
  median,
  oneShotShare,
  percentileRank,
  ratio,
  roundNumberShare,
  sum,
  sumByKey,
  topNShare,
  uniqueCount,
} from '../src/slices/stats.js';

describe('sum, mean, median', () => {
  it('ignore nulls rather than treating them as zero', () => {
    expect(sum([1, null, 2])).toBe(3);
    expect(mean([1, null, 3])).toBe(2);
    expect(median([1, null, 3, 5])).toBe(3);
  });

  it('return null when there is nothing to compute', () => {
    expect(sum([null, null])).toBeNull();
    expect(mean([])).toBeNull();
    expect(median([null])).toBeNull();
  });

  it('median averages the middle pair on an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('median does not care about input order', () => {
    expect(median([9, 1, 5])).toBe(5);
  });
});

describe('ratio', () => {
  it('divides', () => {
    expect(ratio(3, 4)).toBe(0.75);
  });

  it('returns null on a zero denominator rather than Infinity', () => {
    // Infinity survives arithmetic and poisons every average it touches.
    expect(ratio(1, 0)).toBeNull();
  });

  it('returns null when either side is missing', () => {
    expect(ratio(null, 4)).toBeNull();
    expect(ratio(4, null)).toBeNull();
  });
});

describe('topNShare', () => {
  it('measures what fraction sits in the largest entries', () => {
    expect(topNShare([50, 25, 15, 10], 1)).toBe(0.5);
    expect(topNShare([50, 25, 15, 10], 2)).toBe(0.75);
  });

  it('caps at 1 when n exceeds the set', () => {
    expect(topNShare([1, 2, 3], 99)).toBe(1);
  });

  it('returns null for an empty or worthless set', () => {
    expect(topNShare([], 3)).toBeNull();
    expect(topNShare([0, 0], 1)).toBeNull();
  });
});

describe('herfindahl', () => {
  it('is 1 when one participant holds everything', () => {
    expect(herfindahl([100])).toBe(1);
    expect(herfindahl([100, 0, 0])).toBe(1);
  });

  it('is 1/n for n equal participants', () => {
    expect(herfindahl([25, 25, 25, 25])).toBeCloseTo(0.25, 10);
  });

  it('disagrees usefully with topNShare', () => {
    // A hundred equal wash accounts: low top-10 share, low HHI.
    const many = new Array(100).fill(1);
    // Ten whales: high top-10 share, high HHI.
    const few = new Array(10).fill(10);
    expect(topNShare(many, 10)).toBeCloseTo(0.1, 10);
    expect(topNShare(few, 10)).toBe(1);
    expect(herfindahl(many)!).toBeLessThan(herfindahl(few)!);
  });

  it('returns null when there is nothing to divide up', () => {
    expect(herfindahl([])).toBeNull();
    expect(herfindahl([0, 0])).toBeNull();
  });
});

describe('coefficientOfVariation', () => {
  it('is 0 for a perfect timer', () => {
    // The bot signature: every gap identical.
    expect(coefficientOfVariation([60, 60, 60, 60])).toBe(0);
  });

  it('rises with burstiness', () => {
    const bursty = coefficientOfVariation([1, 1, 500, 2, 900])!;
    const steady = coefficientOfVariation([100, 101, 99, 100])!;
    expect(bursty).toBeGreaterThan(1);
    expect(steady).toBeLessThan(0.1);
  });

  it('uses the population standard deviation', () => {
    // Values 2 and 4: mean 3, population sd 1, so CV is 1/3.
    expect(coefficientOfVariation([2, 4])).toBeCloseTo(1 / 3, 10);
  });

  it('needs at least two points', () => {
    expect(coefficientOfVariation([5])).toBeNull();
    expect(coefficientOfVariation([])).toBeNull();
  });

  it('returns null when the mean is zero', () => {
    expect(coefficientOfVariation([0, 0, 0])).toBeNull();
  });
});

describe('interArrivalGaps', () => {
  it('sorts before differencing', () => {
    expect(interArrivalGaps([300, 100, 200])).toEqual([100, 100]);
  });

  it('is empty for fewer than two events', () => {
    expect(interArrivalGaps([5])).toEqual([]);
    expect(interArrivalGaps([])).toEqual([]);
  });
});

describe('oneShotShare', () => {
  it('measures how many keys appear exactly once', () => {
    expect(oneShotShare(['a', 'b', 'c'])).toBe(1);
    expect(oneShotShare(['a', 'a', 'b', 'b'])).toBe(0);
    expect(oneShotShare(['a', 'a', 'b'])).toBe(0.5);
  });

  it('is a share of DISTINCT keys, not of entries', () => {
    // Three entries, two distinct keys, one of which is a one-shot.
    expect(oneShotShare(['a', 'a', 'b'])).toBe(0.5);
  });

  it('returns null for an empty list', () => {
    expect(oneShotShare([])).toBeNull();
  });
});

describe('uniqueCount and sumByKey', () => {
  it('counts distinct keys', () => {
    expect(uniqueCount(['a', 'a', 'b'])).toBe(2);
  });

  it('totals per key', () => {
    const totals = sumByKey([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
      { key: 'a', value: 3 },
    ]);
    expect(totals.get('a')).toBe(4);
    expect(totals.get('b')).toBe(2);
  });
});

describe('percentileRank', () => {
  it('is 1 when the subject beats every peer', () => {
    expect(percentileRank(100, [1, 2, 3])).toBe(1);
  });

  it('is 0 when the subject is below every peer', () => {
    expect(percentileRank(0, [1, 2, 3])).toBe(0);
  });

  it('splits ties down the middle', () => {
    expect(percentileRank(2, [1, 2, 3])).toBeCloseTo(0.5, 10);
  });

  it('returns null with no population or no value', () => {
    expect(percentileRank(1, [])).toBeNull();
    expect(percentileRank(null, [1, 2])).toBeNull();
  });
});

describe('roundNumberShare', () => {
  it('spots amounts written by a human', () => {
    expect(roundNumberShare([1000, 2000, 5000])).toBe(1);
  });

  it('does not flag amounts that came out of a market', () => {
    expect(roundNumberShare([1234.56, 987.65, 4321.09])).toBe(0);
  });

  it('mixes', () => {
    expect(roundNumberShare([1000, 1234.56])).toBe(0.5);
  });

  it('ignores non-positive amounts rather than counting them as round', () => {
    expect(roundNumberShare([0, 0])).toBe(0);
  });

  it('returns null with nothing to look at', () => {
    expect(roundNumberShare([])).toBeNull();
  });
});

describe('hourConcentration', () => {
  it('is 1 when everything lands in one hour', () => {
    // Same hour of the day, seven days apart.
    const sameHour = [0, 86400, 172800].map((d) => d + 3600 * 5);
    expect(hourConcentration(sameHour)).toBeCloseTo(1, 10);
  });

  it('is 0 when events are spread evenly across the day', () => {
    const spread = Array.from({ length: 24 }, (_, h) => h * 3600);
    expect(hourConcentration(spread)).toBeCloseTo(0, 10);
  });

  it('lands in between for realistic waking-hours traffic', () => {
    const daytime: number[] = [];
    for (let h = 8; h < 22; h++) for (let i = 0; i < 10; i++) daytime.push(h * 3600 + i);
    const value = hourConcentration(daytime)!;
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(0.5);
  });

  it('returns null with no events', () => {
    expect(hourConcentration([])).toBeNull();
  });
});
