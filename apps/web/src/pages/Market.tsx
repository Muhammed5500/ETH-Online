/**
 * The live market page — the screen the demo spends most of its time on.
 *
 * It has one job beyond looking alive: make the mechanism's two least
 * believable claims checkable on the spot.
 *
 *   "Nobody could predict when it would stop." The closing panel names the
 *   running hash the final roll came from, the value pulled out of it, and the
 *   alpha it was compared against. A hash on a public mirror node, arithmetic
 *   anyone can redo.
 *
 *   "The last agent is the answer." The reference agent is marked on the chart
 *   and in the feed, and everyone else's score is a function of it.
 *
 * Polling stops on a settled or cancelled market: nothing more can happen, and
 * the API is the same process the orchestrator runs in.
 */
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  hashscan,
  type MarketView,
  type RandomnessResponse,
  type ReportView,
} from '../lib/api.ts';
import { expectedLength, formatHbar, percent, poolExhaustionRisk, relativeTime } from '../lib/format.ts';
import { isTerminal, usePolling } from '../lib/usePolling.ts';
import { PriceChart } from '../components/PriceChart.tsx';
import { Settlement } from '../components/Settlement.tsx';
import { Empty, ErrorBox, Field, Panel, SliceBadge, Spinner, StatusBadge } from '../components/ui.tsx';

const NETWORK = 'testnet';

function Move({ from, to }: { from: number; to: number }): ReactNode {
  const delta = to - from;
  const flat = Math.abs(delta) < 0.0005;
  const colour = flat ? 'text-slate-500' : delta > 0 ? 'text-emerald-400' : 'text-rose-400';
  const arrow = flat ? '→' : delta > 0 ? '↑' : '↓';
  return (
    <span className="font-mono text-xs tnum">
      <span className="text-slate-500">{percent(from)}</span>
      <span className={`mx-1 ${colour}`}>{arrow}</span>
      <span className="text-slate-100">{percent(to)}</span>
      {!flat && (
        <span className={`ml-1.5 ${colour}`}>
          {delta > 0 ? '+' : ''}
          {(delta * 100).toFixed(1)}
        </span>
      )}
    </span>
  );
}

function ReportCard({
  report,
  isReference,
}: {
  report: ReportView;
  isReference: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);

  return (
    <li
      className={`rounded-lg border p-3 ${
        isReference
          ? 'border-violet-800/60 bg-violet-950/20'
          : 'border-[var(--color-edge)] bg-[var(--color-panel)]'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-slate-500">#{report.position}</span>
            <span className="font-mono text-sm text-slate-100">{report.agentId}</span>
            {isReference && (
              <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-300 ring-1 ring-inset ring-violet-500/30">
                reference
              </span>
            )}
            {report.clipped && (
              <span
                title="The agent asked for a bigger move than its bond can carry, so the protocol pulled it back. Clipping happens at report time, not at settlement — clipping a loss afterwards would break the telescoping bound."
                className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30"
              >
                clipped
              </span>
            )}
          </div>
          {report.sliceIds && report.sliceIds.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {report.sliceIds.map((s) => (
                <SliceBadge key={s} id={s} />
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <Move from={report.previousBelief[1]} to={report.belief[1]} />
          {typeof report.evidenceCostUsd === 'number' && (
            <div
              className="mt-1 text-[10px] text-slate-500"
              title="What this agent paid The Graph for its evidence."
            >
              paid ${report.evidenceCostUsd.toFixed(3)} for evidence
            </div>
          )}
        </div>
      </div>

      {report.reasoning && (
        <>
          <button
            onClick={() => setOpen((o) => !o)}
            className="mt-2 text-[11px] text-slate-500 hover:text-slate-300"
          >
            {open ? 'hide reasoning' : 'reasoning'}
          </button>
          {open && (
            <div className="mt-2 rounded border border-[var(--color-edge)] bg-black/20 p-2.5">
              <p className="text-xs leading-relaxed text-slate-300">{report.reasoning}</p>
              <p className="mt-2 text-[10px] text-slate-600">
                Not signed and not scored. The signature covers the probability; this is the
                agent&apos;s account of itself.
              </p>
              {report.evidenceDigest && (
                <p className="mt-1 break-all font-mono text-[10px] text-slate-600">
                  {report.evidenceDigest}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
        active
          ? 'border-slate-200 text-slate-100'
          : 'border-transparent text-slate-500 hover:text-slate-300'
      }`}
    >
      {children}
    </button>
  );
}

function ClosingPanel({
  market,
  randomness,
}: {
  market: MarketView;
  randomness: RandomnessResponse | undefined;
}): ReactNode {
  const closingRoll = randomness?.draws.find((d) => d.purpose === 'stop' && d.stopped);

  return (
    <Panel title="How it closed">
      <dl className="grid grid-cols-2 gap-4">
        <Field
          label="reason"
          value={market.closedReason === 'pool-exhausted' ? 'the pool ran out' : 'the dice landed'}
          hint={
            market.closedReason === 'pool-exhausted'
              ? 'No agents left to draw. In this case the last agent could have known it was the reference — a known limit of a finite pool.'
              : 'A stopping roll came in below alpha.'
          }
        />
        <Field
          label="closing price"
          value={market.reference ? percent(market.reference[1], 2) : '—'}
          hint="The reference agent's report. Everyone is scored against it."
          mono
        />
      </dl>

      {closingRoll ? (
        <div className="mt-4 rounded border border-[var(--color-edge)] bg-black/20 p-3">
          <p className="text-xs text-slate-300">
            The roll that ended it, at report {closingRoll.position}:
          </p>
          <div className="mt-2 space-y-1 font-mono text-[11px] tnum">
            <div className="flex justify-between gap-3">
              <span className="text-slate-500">value</span>
              <span className="text-slate-100">{closingRoll.value.toFixed(9)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-slate-500">α</span>
              <span className="text-slate-100">{closingRoll.alpha?.toFixed(6)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-slate-500">closed because</span>
              <span className="text-emerald-400">value &lt; α</span>
            </div>
          </div>
          <p className="mt-2 break-all font-mono text-[10px] leading-relaxed text-slate-600">
            {closingRoll.runningHash}
          </p>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-500">{randomness?.howToVerify}</p>
        </div>
      ) : (
        market.closedReason === 'pool-exhausted' && (
          <p className="mt-4 text-xs leading-relaxed text-slate-500">
            No roll closed this market — it ran out of agents. Every roll it did make came in
            above α, and there was nobody left to draw.
          </p>
        )
      )}
    </Panel>
  );
}

export function Market(): ReactNode {
  const { id = '' } = useParams();

  const market = usePolling(() => api.market(id), [id], { intervalMs: 2000 });
  const done = isTerminal(market.data?.status);

  const reports = usePolling(() => api.reports(id), [id], {
    intervalMs: 2000,
    enabled: !done,
  });
  const randomness = usePolling(() => api.randomness(id), [id], {
    intervalMs: 3000,
    enabled: !done,
  });
  const settlement = usePolling(() => api.settlement(id), [id], {
    intervalMs: 3000,
    enabled: !done,
  });

  const [tab, setTab] = useState<'reports' | 'settlement'>('reports');

  if (market.loading && !market.settled) return <Spinner label="Loading market" />;
  if (market.error && !market.data) {
    return (
      <ErrorBox
        title="Could not load this market."
        detail={market.error.message}
        retry={market.refresh}
      />
    );
  }

  const m = market.data;
  if (!m) return <Empty>No such market.</Empty>;

  const rows = reports.data?.reports ?? [];
  const lastPosition = rows[rows.length - 1]?.position;
  const isClosed = m.status === 'closed' || m.status === 'settled';
  const expected = expectedLength(m.params);

  return (
    <div className="space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/" className="text-xs text-slate-500 hover:text-slate-300">
            ← markets
          </Link>
          <StatusBadge status={m.status} />
          <span className="font-mono text-[11px] text-slate-500">{m.marketId}</span>
        </div>
        <h1 className="mt-2 max-w-3xl text-lg leading-snug text-slate-100">{m.question}</h1>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Panel
            title="Price"
            aside={
              <span className="font-mono text-lg text-slate-100 tnum">
                {percent(m.currentPrice[1], 1)}
              </span>
            }
          >
            <PriceChart prior={m.prior} reports={rows} isClosed={isClosed} />
            <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
              Each point is one agent&apos;s report. The dashed line is the opening price. An
              agent is paid for the distance it moved the price toward where the market finally
              landed — not for being right in the abstract.
            </p>
          </Panel>

          <div>
            <div className="mb-3 flex gap-1 border-b border-[var(--color-edge)]">
              <TabButton active={tab === 'reports'} onClick={() => setTab('reports')}>
                Reports {rows.length > 0 && <span className="tnum">({rows.length})</span>}
              </TabButton>
              <TabButton active={tab === 'settlement'} onClick={() => setTab('settlement')}>
                Settlement
                {settlement.data?.status === 'blocked' && (
                  <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-400 align-middle" />
                )}
              </TabButton>
            </div>

            {tab === 'reports' ? (
              <Panel>
                {rows.length === 0 ? (
                  <Empty>
                    {m.status === 'bonding'
                      ? 'Agents are still posting bonds. Nobody has reported yet.'
                      : 'No reports yet.'}
                  </Empty>
                ) : (
                  <ul className="space-y-2">
                    {[...rows].reverse().map((r) => (
                      <ReportCard
                        key={r.position}
                        report={r}
                        isReference={isClosed && r.position === lastPosition}
                      />
                    ))}
                  </ul>
                )}
              </Panel>
            ) : (
              <Settlement data={settlement.data} />
            )}
          </div>
        </div>

        <aside className="space-y-6">
          <Panel title="Mechanism">
            <dl className="grid grid-cols-2 gap-4">
              <Field label="k" value={m.params.k} hint="The last k agents take a flat fee." mono />
              <Field label="T" value={m.params.T} hint="Target number of scored agents." mono />
              <Field
                label="α"
                value={m.params.alpha.toFixed(4)}
                hint="Chance of closing after each report."
                mono
              />
              <Field label="ε" value={m.params.epsilon} hint="Reports clipped into [ε, 1-ε]." mono />
              <Field
                label="length"
                value={`${m.reportCount} / ~${expected.toFixed(0)}`}
                hint="Reports so far against the expected 1/α. Running past it is ordinary — the stopping rule is geometric."
                mono
              />
              <Field
                label="pool"
                value={`${m.bondedCount} / ${m.params.minPoolSize}`}
                hint="Agents bonded against the minimum this market needs."
                mono
              />
            </dl>

            {m.status === 'running' && (
              <div className="mt-4 border-t border-[var(--color-edge)] pt-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500">chance the next report is the last</span>
                  <span className="font-mono text-slate-200 tnum">{percent(m.params.alpha)}</span>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-slate-500">chance the pool runs dry</span>
                  <span className="font-mono text-slate-200 tnum">
                    {percent(poolExhaustionRisk(m.params, m.bondedCount))}
                  </span>
                </div>
              </div>
            )}

            <div className="mt-4 space-y-2 border-t border-[var(--color-edge)] pt-4">
              <Field label="deposit" value={formatHbar(m.depositTinybar)} mono />
              <Field label="bond per agent" value={formatHbar(m.bondTinybar)} mono />
              <Field
                label="opened"
                value={relativeTime(m.createdAt)}
                hint={new Date(m.createdAt).toISOString()}
              />
            </div>
          </Panel>

          <Panel title="On chain">
            <a
              href={hashscan(NETWORK, 'topic', m.topicId)}
              target="_blank"
              rel="noreferrer"
              className="block font-mono text-sm text-sky-300 underline decoration-sky-800 underline-offset-2 hover:text-sky-200"
            >
              {m.topicId}
            </a>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              Every report, the close and the settlement are on this topic, ordered by consensus
              and immutable — the topic has no admin key, so not even we can rewrite it.
            </p>
            {randomness.data?.pendingHidden && (
              <p className="mt-3 rounded border border-[var(--color-edge)] bg-black/20 p-2 text-[11px] leading-relaxed text-slate-400">
                An agent has been drawn and has not reported. Its draw is deliberately not
                published: naming it would say who speaks next, and the order is meant to be
                unknowable in advance.
              </p>
            )}
          </Panel>

          {isClosed && <ClosingPanel market={m} randomness={randomness.data} />}
        </aside>
      </div>
    </div>
  );
}
