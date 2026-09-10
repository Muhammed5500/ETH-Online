/**
 * The market list.
 *
 * What a card has to convey at a glance, in order: what was asked, what the
 * market currently believes, and how far through it is. The price is the
 * headline because it is the market's actual output — everything else on the
 * card is context for reading it.
 *
 * The progress bar is `reportCount / (1/alpha)` and is capped at full rather
 * than allowed to overflow. The stopping rule is geometric, so a market can
 * and does run past its expected length; a bar showing 180% would suggest
 * something is wrong when nothing is.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type MarketView } from '../lib/api.ts';
import { expectedLength, formatHbar, percent, relativeTime } from '../lib/format.ts';
import { usePolling } from '../lib/usePolling.ts';
import { Empty, ErrorBox, Spinner, StatusBadge } from '../components/ui.tsx';

function PriceDial({ market }: { market: MarketView }): ReactNode {
  const p = market.currentPrice[1];
  const moved = market.reportCount > 0;
  return (
    <div className="shrink-0 text-right">
      <div className={`text-2xl font-semibold tnum ${moved ? 'text-slate-100' : 'text-slate-500'}`}>
        {percent(p)}
      </div>
      <div className="text-[11px] text-slate-500">
        {moved ? 'current price' : 'prior, no reports yet'}
      </div>
    </div>
  );
}

function MarketCard({ market }: { market: MarketView }): ReactNode {
  const expected = expectedLength(market.params);
  const progress = Math.min(1, market.reportCount / expected);

  return (
    <Link
      to={`/m/${market.marketId}`}
      className="block rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-4 transition hover:border-slate-600"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusBadge status={market.status} />
            <span className="font-mono text-[11px] text-slate-500">{market.marketId}</span>
          </div>
          <p className="mt-2 text-sm leading-snug text-slate-100">{market.question}</p>
        </div>
        <PriceDial market={market} />
      </div>

      <div className="mt-3 h-1 overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-slate-500"
          style={{ width: `${progress * 100}%` }}
          title={`${market.reportCount} reports, expected length ${expected.toFixed(1)}`}
        />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-500 sm:grid-cols-4">
        <div>
          <dt className="inline">reports </dt>
          <dd className="inline tnum text-slate-300">
            {market.reportCount} / ~{expected.toFixed(0)}
          </dd>
        </div>
        <div>
          <dt className="inline">pool </dt>
          <dd className="inline tnum text-slate-300">
            {market.bondedCount} / {market.params.minPoolSize}
          </dd>
        </div>
        <div>
          <dt className="inline">deposit </dt>
          <dd className="inline tnum text-slate-300">{formatHbar(market.depositTinybar, 2)}</dd>
        </div>
        <div>
          <dt className="inline">
            {market.status === 'bonding' ? 'bonding closes ' : 'opened '}
          </dt>
          <dd className="inline tnum text-slate-300">
            {relativeTime(
              market.status === 'bonding' ? market.bondingClosesAt : market.createdAt,
            )}
          </dd>
        </div>
      </dl>
    </Link>
  );
}

/** Live markets first, then the record. Sorted newest-first inside each group. */
function partition(markets: readonly MarketView[]): {
  live: MarketView[];
  done: MarketView[];
} {
  const live = markets.filter((m) => m.status === 'bonding' || m.status === 'running');
  const done = markets.filter((m) => m.status !== 'bonding' && m.status !== 'running');
  return { live, done };
}

export function MarketList(): ReactNode {
  const { data, error, loading, settled } = usePolling(() => api.markets(), [], {
    intervalMs: 3000,
  });

  if (loading && !settled) return <Spinner label="Loading markets" />;
  if (error && !data) {
    return <ErrorBox title="Could not load markets." detail={error.message} />;
  }

  const markets = data?.markets ?? [];
  const { live, done } = partition(markets);

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Markets</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Questions no oracle can settle. Agents post a bond, report in turn, and the market
            resolves against its own last agent — nothing outside it is consulted.
          </p>
        </div>
        <Link
          to="/new"
          className="shrink-0 rounded-md bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900 transition hover:bg-white"
        >
          Ask a question
        </Link>
      </header>

      {markets.length === 0 && <Empty>No markets yet. Ask the first question.</Empty>}

      {live.length > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">
            Open — {live.length}
          </h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {live.map((m) => (
              <MarketCard key={m.marketId} market={m} />
            ))}
          </div>
        </section>
      )}

      {done.length > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">
            Resolved — {done.length}
          </h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {done.map((m) => (
              <MarketCard key={m.marketId} market={m} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
