/**
 * The price chart.
 *
 * WHAT IT HAS TO MAKE OBVIOUS, in the roadmap's words: that the price moves,
 * and that the agents disagree. A chart where twenty dots sit at 72% would be
 * technically correct and would kill the demo.
 *
 * Three decisions carry that:
 *
 *   Position 0 is the prior, drawn as a point like any other. The first
 *   agent's report is a MOVE from the opening price, and the scoring rule pays
 *   for moves. Starting the line at report 1 would hide the largest move most
 *   markets ever make.
 *
 *   The y axis is pinned to [0, 1] and never auto-scaled. Recharts would
 *   happily zoom into 0.68–0.74 and turn a boring market into a dramatic one.
 *   The flatness of a converged market is information.
 *
 *   The reference agent's point is drawn larger and labelled. Everyone is
 *   scored against it, so it is not merely the last point — it is the answer.
 */
import type { ReactNode } from 'react';
import {
  CartesianGrid,
  Dot,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Belief } from '@ethonline/core';
import type { ReportView } from '../lib/api.ts';
import { percent } from '../lib/format.ts';
import { buildSeries, type PricePoint } from '../lib/series.ts';

export { buildSeries, type PricePoint } from '../lib/series.ts';

function PointDot(props: {
  cx?: number;
  cy?: number;
  payload?: PricePoint;
}): ReactNode {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || !payload) return null;

  if (payload.isReference) {
    return (
      <g>
        <circle cx={cx} cy={cy} r={9} fill="#a78bfa" fillOpacity={0.18} />
        <circle cx={cx} cy={cy} r={4.5} fill="#a78bfa" stroke="#0d1117" strokeWidth={1.5} />
      </g>
    );
  }
  if (payload.position === 0) {
    return <circle cx={cx} cy={cy} r={3} fill="#64748b" stroke="#0d1117" strokeWidth={1.5} />;
  }
  return (
    <Dot
      cx={cx}
      cy={cy}
      r={3}
      fill={payload.clipped ? '#fbbf24' : '#e2e8f0'}
      stroke="#0d1117"
      strokeWidth={1.5}
    />
  );
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: PricePoint }>;
}): ReactNode {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="rounded border border-[var(--color-edge)] bg-black/90 px-2.5 py-1.5 text-xs">
      <div className="font-mono text-slate-100 tnum">{percent(point.p, 2)}</div>
      <div className="mt-0.5 text-[11px] text-slate-400">
        {point.position === 0 ? 'opening price' : `report ${point.position} · ${point.agentId}`}
      </div>
      {point.isReference && (
        <div className="mt-0.5 text-[11px] text-violet-300">reference agent</div>
      )}
      {point.clipped && (
        <div className="mt-0.5 text-[11px] text-amber-300">clipped to the bond limit</div>
      )}
    </div>
  );
}

export function PriceChart({
  prior,
  reports,
  isClosed,
}: {
  prior: Belief;
  reports: readonly ReportView[];
  isClosed: boolean;
}): ReactNode {
  const data = buildSeries(prior, reports, isClosed);

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
          <CartesianGrid stroke="#1c2531" strokeDasharray="2 4" />
          <XAxis
            dataKey="position"
            stroke="#475569"
            tick={{ fill: '#64748b', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: '#1c2531' }}
            label={{
              value: 'report',
              position: 'insideBottomRight',
              offset: -2,
              fill: '#475569',
              fontSize: 11,
            }}
          />
          <YAxis
            domain={[0, 1]}
            ticks={[0, 0.25, 0.5, 0.75, 1]}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            stroke="#475569"
            tick={{ fill: '#64748b', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          {/* The opening price, so every move is read against where it started. */}
          <ReferenceLine y={prior[1]} stroke="#334155" strokeDasharray="4 4" />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#334155' }} />
          <Line
            type="linear"
            dataKey="p"
            stroke="#e2e8f0"
            strokeWidth={1.5}
            dot={<PointDot />}
            activeDot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
