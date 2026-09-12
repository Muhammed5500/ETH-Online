/**
 * The market list.
 *
 * TWO GROUPS, AND THEY ARE NOT THE SAME OBJECT. A market that is still running
 * has a price that will change; a market that has closed has an answer that
 * never will. Showing them in one undifferentiated grid invites the reader to
 * treat a live number as a result — the single most misleading thing this page
 * could do. So the live ones come first, carry the accent and a beating dot,
 * and say "current price"; the resolved ones are quieter, and their number is
 * labelled "answer".
 *
 * WHAT A CARD SAYS, IN ORDER. What was asked, what the market believes, and how
 * far through it is. The question is the largest text because it is the only
 * part a reader cannot reconstruct from anything else on screen.
 *
 * The progress bar is `reportCount / (1/alpha)` and is capped at full rather
 * than allowed to overflow. The stopping rule is geometric, so a market can and
 * does run past its expected length; a bar at 180% would suggest something is
 * wrong when nothing is.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type MarketView } from '../lib/api.ts';
import { expectedLength, formatHbar, percent, relativeTime } from '../lib/format.ts';
import { usePolling } from '../lib/usePolling.ts';
import { Empty, ErrorBox, LiveDot, Spinner, StatusBadge } from '../components/ui.tsx';

function Price({ market, live }: { market: MarketView; live: boolean }): ReactNode {
  const p = market.currentPrice[1];
  const moved = market.reportCount > 0;
  return (
    <div className="shrink-0 text-right">
      <div
        className={`text-3xl font-semibold tracking-tight tnum ${
          moved ? 'text-[var(--color-fg)]' : 'text-[var(--color-fg-faint)]'
        }`}
      >
        {percent(p)}
      </div>
      <div className="mt-0.5 text-[11px] text-[var(--color-fg-faint)]">
        {!moved ? 'prior, no reports yet' : live ? 'current price' : 'answer'}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div>
      <dt className="text-[11px] text-[var(--color-fg-faint)]">{label}</dt>
      <dd className="mt-0.5 font-mono text-xs text-[var(--color-fg-muted)] tnum">{value}</dd>
    </div>
  );
}

function MarketCard({ market, live }: { market: MarketView; live: boolean }): ReactNode {
  const expected = expectedLength(market.params);
  const progress = Math.min(1, market.reportCount / expected);
  const running = market.status === 'running';

  return (
    <Link
      to={`/m/${market.marketId}`}
      className={`card card-hover block p-5 ${live ? 'border-l-2 border-l-[var(--color-accent)]' : ''}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {running && <LiveDot />}
            <StatusBadge status={market.status} />
            <span className="font-mono text-[11px] text-[var(--color-fg-faint)]">
              {market.marketId}
            </span>
          </div>
          <p className="mt-2.5 text-[15px] leading-snug text-[var(--color-fg)]">
            {market.question}
          </p>
        </div>
        <Price market={market} live={live} />
      </div>

      <div className="mt-4 h-1 overflow-hidden rounded-full bg-[var(--color-edge)]">
        <div
          className={`h-full rounded-full ${live ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-edge-strong)]'}`}
          style={{ width: `${progress * 100}%` }}
          title={`${market.reportCount} reports, expected length ${expected.toFixed(1)}`}
        />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Stat label="reports" value={`${market.reportCount} / ~${expected.toFixed(0)}`} />
        <Stat label="pool" value={`${market.bondedCount} / ${market.params.minPoolSize}`} />
        <Stat label="deposit" value={formatHbar(market.depositTinybar, 2)} />
        <Stat
          label={market.status === 'bonding' ? 'bonding closes' : 'opened'}
          value={relativeTime(
            market.status === 'bonding' ? market.bondingClosesAt : market.createdAt,
          )}
        />
      </dl>
    </Link>
  );
}

function SectionHeading({
  title,
  count,
  note,
}: {
  title: string;
  count: number;
  note: string;
}): ReactNode {
  return (
    <div className="mb-4 flex items-baseline gap-3 border-b border-[var(--color-edge)] pb-2">
      <h2 className="text-sm font-semibold text-[var(--color-fg)]">{title}</h2>
      <span className="rounded-full bg-[var(--color-edge)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-fg-muted)] tnum">
        {count}
      </span>
      <span className="text-[11px] text-[var(--color-fg-faint)]">{note}</span>
    </div>
  );
}

/** Live markets first, then the record. Newest first inside each group. */
function partition(markets: readonly MarketView[]): { live: MarketView[]; done: MarketView[] } {
  const isLive = (m: MarketView): boolean => m.status === 'bonding' || m.status === 'running';
  return { live: markets.filter(isLive), done: markets.filter((m) => !isLive(m)) };
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
  const answered = done.filter((m) => m.reference).length;

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            Questions no oracle can settle
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--color-fg-muted)]">
            Agents post a bond, are drawn one at a time, and report in turn. The market closes at a
            random point and resolves against its own last agent — nothing outside it is ever
            consulted.
          </p>
          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-[var(--color-fg-faint)]">
            <span>
              <span className="font-mono text-[var(--color-fg-muted)] tnum">{live.length}</span>{' '}
              running now
            </span>
            <span>
              <span className="font-mono text-[var(--color-fg-muted)] tnum">{answered}</span>{' '}
              answered
            </span>
            <span>every report on a public Hedera topic</span>
          </div>
        </div>
        <Link
          to="/new"
          className="shrink-0 rounded-md bg-[var(--color-accent)] px-4 py-2.5 text-sm font-medium text-[#04121f] transition hover:bg-[var(--color-accent-strong)]"
        >
          Ask a question
        </Link>
      </header>

      {markets.length === 0 && <Empty>No markets yet. Ask the first question.</Empty>}

      {live.length > 0 && (
        <section>
          <SectionHeading
            title="Open"
            count={live.length}
            note="still moving — the price here is not an answer yet"
          />
          <div className="grid gap-4 lg:grid-cols-2">
            {live.map((m) => (
              <MarketCard key={m.marketId} market={m} live />
            ))}
          </div>
        </section>
      )}

      {done.length > 0 && (
        <section>
          <SectionHeading
            title="Resolved"
            count={done.length}
            note="closed against the terminal agent; the price is final"
          />
          <div className="grid gap-4 lg:grid-cols-2">
            {done.map((m) => (
              <MarketCard key={m.marketId} market={m} live={false} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
