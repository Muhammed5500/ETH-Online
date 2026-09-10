/**
 * Turning a market into the points the chart draws.
 *
 * Pure, and in its own file rather than beside the component, for a reason the
 * roadmap is explicit about: `pnpm test` has to stay off the network and in
 * the seconds. Importing this from the chart component would drag recharts
 * into the unit suite and cost half a minute of module loading for arithmetic
 * that has no opinion about rendering.
 */
import type { Belief } from '@ethonline/core';
import type { ReportView } from './api.ts';

export interface PricePoint {
  readonly position: number;
  readonly p: number;
  readonly agentId?: string;
  readonly isReference: boolean;
  readonly clipped: boolean;
}

export function buildSeries(
  prior: Belief,
  reports: readonly ReportView[],
  isClosed: boolean,
): PricePoint[] {
  const points: PricePoint[] = [
    { position: 0, p: prior[1], isReference: false, clipped: false },
  ];
  for (const r of reports) {
    points.push({
      position: r.position,
      p: r.belief[1],
      agentId: r.agentId,
      // Only a closed market HAS a reference. While it is running the last
      // report is just the latest one, and marking it as the answer would
      // claim the market had settled when it had not.
      isReference: isClosed && r.position === reports[reports.length - 1]?.position,
      clipped: r.clipped,
    });
  }
  return points;
}
