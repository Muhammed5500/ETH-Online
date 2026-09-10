/**
 * Price chart series tests.
 *
 * Two claims the chart makes with its shape rather than with words, and both
 * would be wrong in a way nobody would notice by looking:
 *
 *   The line starts at the opening price, not at the first report. The scoring
 *   rule pays for MOVES, and the first agent's move is from the prior. A chart
 *   that begins at report 1 hides the largest move most markets ever make.
 *
 *   Only a CLOSED market has a reference agent. While it is running the last
 *   report is merely the latest one; marking it as the answer would claim the
 *   market had settled when it had not — and the reference is what every other
 *   agent's payout is computed against.
 *
 * `buildSeries` lives in `lib/` rather than beside the chart so this file can
 * import it without pulling recharts into the unit suite.
 */
import { describe, expect, it } from 'vitest';
import type { Belief } from '@ethonline/core';
import { buildSeries } from '../src/lib/series.ts';
import type { ReportView } from '../src/lib/api.ts';

const PRIOR: Belief = [0.5, 0.5];

function report(position: number, p: number, over: Partial<ReportView> = {}): ReportView {
  return {
    position,
    agentId: `agent-${String(position).padStart(2, '0')}`,
    belief: [1 - p, p],
    rawBelief: [1 - p, p],
    previousBelief: PRIOR,
    clipped: false,
    timestamp: 1_700_000_000_000 + position,
    ...over,
  };
}

describe('buildSeries', () => {
  it('starts at the opening price', () => {
    const s = buildSeries(PRIOR, [report(1, 0.7)], false);
    expect(s[0]).toMatchObject({ position: 0, p: 0.5, isReference: false });
  });

  it('is just the prior when nothing has been reported', () => {
    const s = buildSeries([0.3, 0.7], [], false);
    expect(s).toHaveLength(1);
    expect(s[0]!.p).toBe(0.7);
  });

  it('keeps reports in order and carries the agent through', () => {
    const s = buildSeries(PRIOR, [report(1, 0.7), report(2, 0.4), report(3, 0.55)], false);
    expect(s.map((x) => x.position)).toEqual([0, 1, 2, 3]);
    expect(s.map((x) => x.p)).toEqual([0.5, 0.7, 0.4, 0.55]);
    expect(s[2]!.agentId).toBe('agent-02');
  });

  it('marks NO reference while the market is still running', () => {
    const s = buildSeries(PRIOR, [report(1, 0.7), report(2, 0.4)], false);
    expect(s.some((x) => x.isReference)).toBe(false);
  });

  it('marks the last report as the reference once it has closed', () => {
    const s = buildSeries(PRIOR, [report(1, 0.7), report(2, 0.4)], true);
    expect(s.filter((x) => x.isReference)).toHaveLength(1);
    expect(s[s.length - 1]!.isReference).toBe(true);
  });

  it('never marks the prior as the reference, even on a closed market with no reports', () => {
    // A market can close with nothing reported — every agent timed out. There
    // is no reference agent then, and the opening price is not one.
    const s = buildSeries(PRIOR, [], true);
    expect(s).toHaveLength(1);
    expect(s[0]!.isReference).toBe(false);
  });

  it('carries the clip flag so a clipped report can be drawn differently', () => {
    const s = buildSeries(PRIOR, [report(1, 0.9, { clipped: true, rawBelief: [0.01, 0.99] })], false);
    expect(s[1]!.clipped).toBe(true);
  });

  it('plots the clipped belief, not what the agent asked for', () => {
    // The clipped value is what the market priced and what scoring uses. The
    // raw value is audit evidence, not the price.
    const s = buildSeries(PRIOR, [report(1, 0.9, { clipped: true, rawBelief: [0.01, 0.99] })], false);
    expect(s[1]!.p).toBe(0.9);
  });
});
