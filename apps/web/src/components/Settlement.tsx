/**
 * Where the money went.
 *
 * THE BUDGET BOUND SITS AT THE TOP, and the roadmap is right that it is the
 * small detail worth the most. Every prediction market can show a payout
 * table. Almost none can show that the operator's total cost was capped before
 * the market opened, by an argument rather than by a limit somebody typed in.
 *
 * The claim is paper §6.2: the CE-MSR payments telescope, so
 * `Σ_t S_CEM(r, qᵗ, qᵗ⁻¹) = S_CE(r, q_last) - S_CE(r, q⁰)`, and since
 * `H(r, q_last) ≥ 0` the whole sum is capped at `b·H(r, q⁰)` — no matter how
 * long the market ran or how violently the price swung. Two numbers, one
 * comparison, and a reader who knows the paper will recognise it instantly.
 *
 * COLOUR MEANS MONEY DIRECTION AND NOTHING ELSE. Green is paid out, red is
 * taken from a bond, grey is a flat fee that was never scored. No colour is
 * used decoratively anywhere on this screen, because someone reading it off a
 * projector has one glance to work out who lost.
 */
import type { ReactNode } from 'react';
import type { SettlementView, TransferView } from '../lib/api.ts';
import { hashscan } from '../lib/api.ts';
import { formatHbar, percent } from '../lib/format.ts';
import { Empty, Field, Panel } from './ui.tsx';

const NETWORK = 'testnet';

function Amount({ units }: { units: number }): ReactNode {
  const zero = Math.abs(units) < 5e-7;
  const colour = zero ? 'text-slate-400' : units > 0 ? 'text-emerald-400' : 'text-rose-400';
  return (
    <span className={`font-mono tnum ${colour}`}>
      {units > 0 && !zero ? '+' : ''}
      {units.toFixed(6)}
    </span>
  );
}

function BoundPanel({ bound }: { bound: NonNullable<SettlementView['bound']> }): ReactNode {
  const used = bound.maxScoringUnits > 0 ? bound.actualScoringUnits / bound.maxScoringUnits : 0;
  // A negative net spend is normal and means the market took MORE off wrong
  // moves than it paid for right ones. Clamped so the bar cannot run backwards.
  const width = Math.max(0, Math.min(1, used));

  return (
    <Panel title="The asker's cost was capped before the market opened">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <div className="text-xs text-slate-500">spent on scoring</div>
          <div className="mt-0.5 font-mono text-xl text-slate-100 tnum">
            {bound.actualScoringUnits.toFixed(6)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-slate-500">theoretical maximum</div>
          <div className="mt-0.5 font-mono text-xl text-slate-400 tnum">
            {bound.maxScoringUnits.toFixed(6)}
          </div>
        </div>
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full ${bound.withinBound ? 'bg-emerald-500/70' : 'bg-rose-500'}`}
          style={{ width: `${width * 100}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[11px]">
        <span className={bound.withinBound ? 'text-emerald-400' : 'text-rose-400'}>
          {bound.withinBound ? 'within the bound' : 'BOUND EXCEEDED — the mechanism is broken'}
        </span>
        <span className="text-slate-500 tnum">{percent(width)} of the cap</span>
      </div>

      {bound.actualScoringUnits < 0 && (
        <p className="mt-3 text-[11px] leading-relaxed text-emerald-300/80">
          Negative, and that is a real outcome rather than a rounding artefact: this market took
          more off agents that moved the price away from where it landed than it paid to the ones
          that moved it closer. The asker got back more than the scoring part of the deposit —
          the cap binds the cost, not the sign.
        </p>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
        The cap is <code className="text-slate-400">b·H(r, q⁰)</code>. It holds because the
        cross-entropy payments telescope — every intermediate price cancels, leaving only the
        opening price and the closing one — so a market that ran for twenty reports and swung from
        80% to 19% and back costs the asker no more than one that barely moved. Paper §6.2.
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-4 border-t border-[var(--color-edge)] pt-3">
        <Field
          label="flat fees paid"
          value={bound.flatFeeUnits.toFixed(4)}
          hint="k·R, outside the scoring bound and added to the deposit separately."
        />
        <Field
          label="deposit required"
          value={bound.requiredDepositUnits.toFixed(4)}
          hint="What the asker had to put up: the worst-case scoring bound plus the flat fees."
        />
      </dl>
    </Panel>
  );
}

function PayoutTable({ payouts }: { payouts: NonNullable<SettlementView['payouts']> }): ReactNode {
  return (
    <Panel title={`Payouts — ${payouts.length}`}>
      <div className="-mx-4 overflow-x-auto px-4">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b border-[var(--color-edge)] text-left text-[11px] text-slate-500">
              <th className="pb-2 font-medium">#</th>
              <th className="pb-2 font-medium">agent</th>
              <th className="pb-2 font-medium">kind</th>
              <th className="pb-2 text-right font-medium">raw score</th>
              <th className="pb-2 text-right font-medium">payout</th>
            </tr>
          </thead>
          <tbody>
            {payouts.map((p) => (
              <tr key={p.position} className="border-b border-[var(--color-edge)]/60 last:border-0">
                <td className="py-2 font-mono text-[11px] text-slate-500 tnum">{p.position}</td>
                <td className="py-2 font-mono text-slate-200">{p.agentId}</td>
                <td className="py-2">
                  {p.kind === 'flat-fee' ? (
                    <span
                      title="One of the last k agents. There was not enough information behind it to score against, so it takes a fixed fee. Which agents these are is decided by where the dice landed, not in advance."
                      className="rounded bg-slate-500/15 px-1.5 py-0.5 text-[10px] text-slate-400 ring-1 ring-inset ring-slate-500/30"
                    >
                      flat fee
                    </span>
                  ) : (
                    <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300 ring-1 ring-inset ring-sky-500/25">
                      scored
                    </span>
                  )}
                </td>
                <td className="py-2 text-right font-mono text-[11px] text-slate-500 tnum">
                  {typeof p.scoreRaw === 'number' ? p.scoreRaw.toFixed(6) : '—'}
                </td>
                <td className="py-2 text-right">
                  <Amount units={p.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        A negative payout is taken from that agent&apos;s bond and refunded to the asker — never
        shared out among the others. An agent&apos;s profit comes from the asker&apos;s fee, not
        from a rival&apos;s mistake, which is what keeps this a market rather than a contest.
      </p>
    </Panel>
  );
}

function AccountingPanel({
  totals,
  accounting,
}: {
  totals: NonNullable<SettlementView['totals']>;
  accounting: NonNullable<SettlementView['accounting']>;
}): ReactNode {
  const row = (label: string, value: string, hint?: string, dim = false): ReactNode => (
    <div className="flex justify-between gap-4 py-1" title={hint}>
      <dt className={dim ? 'text-slate-500' : 'text-slate-400'}>{label}</dt>
      <dd className="font-mono text-slate-200 tnum">{value}</dd>
    </div>
  );

  return (
    <Panel title="Accounting">
      <dl className="text-xs">
        <div className="text-[11px] uppercase tracking-wide text-slate-600">in</div>
        {row('asker deposit', totals.deposit.toFixed(4))}
        {row('agent bonds', totals.totalBonds.toFixed(4))}

        <div className="mt-3 text-[11px] uppercase tracking-wide text-slate-600">out</div>
        {row('bonds returned', totals.bondsReturned.toFixed(4))}
        {row('net scores and fees', totals.scoreTotal.toFixed(4))}
        {row(
          'slashed for silence',
          totals.timeoutSlash.toFixed(4),
          'A drawn agent that never answered forfeits its whole bond. It goes to the asker, not to the other agents.',
        )}
        {row(
          'taken from negative scores',
          totals.scoreSlash.toFixed(4),
          'Refunded to the asker, never redistributed.',
        )}
        {row('asker refund', totals.askerRefund.toFixed(4))}

        <div className="mt-3 flex justify-between gap-4 border-t border-[var(--color-edge)] pt-3">
          <dt className={accounting.balances ? 'text-emerald-400' : 'text-rose-400'}>
            {accounting.balances ? 'in = out' : 'DOES NOT BALANCE'}
          </dt>
          <dd className="font-mono text-[11px] text-slate-400 tnum">
            {formatHbar(accounting.inTinybar, 8)} = {formatHbar(accounting.outTinybar, 8)}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        Checked in whole tinybar, not in floating point. Agents are rounded down and the asker
        receives the exact remainder, so the identity holds as integers rather than approximately.
      </p>
    </Panel>
  );
}

const TRANSFER_LABEL: Record<TransferView['kind'], string> = {
  scored: 'bond + score',
  'flat-fee': 'bond + flat fee',
  'not-drawn': 'bond returned, never drawn',
  'timed-out': 'bond forfeited',
  asker: 'refund',
};

function TransferTable({
  transfers,
  topicId,
}: {
  transfers: NonNullable<SettlementView['transfers']>;
  topicId?: string;
}): ReactNode {
  return (
    <Panel
      title={`Transfers — ${transfers.length}`}
      aside={
        topicId && (
          <a
            href={hashscan(NETWORK, 'topic', topicId)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-sky-300 hover:text-sky-200"
          >
            {topicId}
          </a>
        )
      }
    >
      <div className="-mx-4 overflow-x-auto px-4">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b border-[var(--color-edge)] text-left text-[11px] text-slate-500">
              <th className="pb-2 font-medium">to</th>
              <th className="pb-2 font-medium">what</th>
              <th className="pb-2 text-right font-medium">amount</th>
              <th className="pb-2 text-right font-medium">transaction</th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((t) => (
              <tr
                key={t.beneficiary}
                className="border-b border-[var(--color-edge)]/60 last:border-0"
              >
                <td className="py-2 font-mono text-slate-200">
                  {t.beneficiary}
                  <span className="ml-1.5 text-[10px] text-slate-600">{t.accountId}</span>
                </td>
                <td className="py-2 text-[11px] text-slate-500">{TRANSFER_LABEL[t.kind]}</td>
                <td className="py-2 text-right font-mono text-slate-200 tnum">
                  {formatHbar(t.amountTinybar)}
                </td>
                <td className="py-2 text-right">
                  {t.transactionId ? (
                    <a
                      href={hashscan(NETWORK, 'transaction', t.transactionId)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[10px] text-sky-300 hover:text-sky-200"
                    >
                      chunk {t.chunkIndex}
                    </a>
                  ) : (
                    <span
                      title={
                        t.chunkState === 'unknown'
                          ? 'This transfer was attempted and its outcome is not known. It may or may not have moved money; a person has to check the treasury history before the settlement can continue.'
                          : 'Not sent yet.'
                      }
                      className={`text-[10px] ${t.chunkState === 'unknown' ? 'text-amber-400' : 'text-slate-600'}`}
                    >
                      {t.chunkState ?? 'pending'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function Settlement({ data }: { data: SettlementView | undefined }): ReactNode {
  if (!data) return <Empty>Loading settlement.</Empty>;

  if (data.status === 'not-settled') {
    return (
      <Empty>
        {data.marketStatus === 'cancelled'
          ? 'This market never started — the pool did not reach its minimum, so every bond was refunded in full.'
          : 'Not settled yet. Nobody is paid until the market closes, because every score depends on where it lands.'}
      </Empty>
    );
  }

  return (
    <div className="space-y-6">
      {data.status === 'blocked' && data.progress && (
        <div className="rounded-lg border border-amber-900/60 bg-amber-950/25 p-4">
          <p className="text-sm font-medium text-amber-200">Settlement stopped partway.</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
            {data.progress.sent} of {data.progress.chunks} transfers are confirmed and{' '}
            {data.progress.unknown} has an outcome nobody knows yet — it may or may not have moved
            money. It will not be retried automatically, because retrying a payment whose outcome
            is unknown is how one gets made twice.
          </p>
        </div>
      )}

      {data.bound && <BoundPanel bound={data.bound} />}
      {data.payouts && <PayoutTable payouts={data.payouts} />}
      {data.totals && data.accounting && (
        <AccountingPanel totals={data.totals} accounting={data.accounting} />
      )}
      {data.transfers && <TransferTable transfers={data.transfers} topicId={data.topicId} />}
    </div>
  );
}
