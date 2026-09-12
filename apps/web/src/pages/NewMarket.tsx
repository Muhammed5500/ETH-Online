/**
 * Asking a question.
 *
 * THE DEPOSIT FIGURE IS THE POINT OF THIS PAGE. It is not a price the protocol
 * picked; it is the bound that makes the asker's total cost provably finite
 * (paper §6.2, telescoping). Showing it live, split into the two terms it is
 * made of, is what turns "trust us, it is capped" into something the reader
 * can watch respond to the parameters they are changing.
 *
 * The bound is `b · max_i(-log q⁰_i) + k·R`. The paper writes the scoring term
 * as `b·H(r, q⁰)`, which needs `r` — the reference agent's report, unknown
 * when the market opens. So the price takes the worst case over `r`, and the
 * two coincide only at a uniform prior, where both are `b·log2`. The
 * consequence is worth getting right, because the first draft of this page
 * said the opposite: a confident prior makes a market MORE expensive to
 * subsidise, not less.
 *
 * It comes from `requiredDeposit` in `@ethonline/core` — the same function the
 * API prices the x402 challenge with. Not a copy of the formula: the formula.
 *
 * The parameter validation is `core`'s too, so the warnings here are the same
 * ones the server would raise. Push `k` up and the pool-exhaustion warning
 * appears, because a larger `k` means a smaller alpha, a longer market and a
 * pool that runs dry more often — a trade-off the paper does not cover, since
 * it assumes an unbounded pool.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DEFAULT_PARAMS,
  beliefFromProbability,
  suggestedAlpha,
  validateParams,
  type MarketParams,
} from '@ethonline/core';
import { ApiError, api } from '../lib/api.ts';
import { useWallet } from '../lib/useWallet.tsx';
import { depositBreakdown, expectedLength, formatHbar, percent, poolExhaustionRisk } from '../lib/format.ts';
import { ErrorBox, Field, Panel } from '../components/ui.tsx';

const EXAMPLES = [
  'Is the last 30 days of TVL growth on this protocol organic, or wash-farmed?',
  'Does this address cluster belong to a single actor?',
  "Does this token's liquidity structure carry rug risk?",
  'Is this DAO proposal net positive for the treasury?',
];

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  max?: number;
  hint: string;
}): ReactNode {
  return (
    <label className="block">
      <span className="text-xs text-slate-400" title={hint}>
        {label}
      </span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full rounded border border-[var(--color-edge)] bg-black/30 px-2 py-1.5 font-mono text-sm text-slate-100 tnum outline-none focus:border-slate-500"
      />
      <span className="mt-1 block text-[11px] leading-tight text-slate-600">{hint}</span>
    </label>
  );
}

export function NewMarket(): ReactNode {
  const navigate = useNavigate();
  const wallet = useWallet();
  const [question, setQuestion] = useState('');
  const [priorPercent, setPriorPercent] = useState(50);
  const [params, setParams] = useState<MarketParams>(DEFAULT_PARAMS);
  const [advanced, setAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | undefined>(undefined);

  const set = (patch: Partial<MarketParams>): void => setParams((p) => ({ ...p, ...patch }));

  const prior = useMemo(() => beliefFromProbability(priorPercent / 100), [priorPercent]);
  const validation = useMemo(() => validateParams(params), [params]);
  const deposit = useMemo(
    () => (validation.ok ? depositBreakdown(params, prior) : undefined),
    [params, prior, validation.ok],
  );
  const exhaustion = poolExhaustionRisk(params, params.minPoolSize);
  const alphaSuggested = suggestedAlpha(params.T, params.k);

  const canSubmit = question.trim().length >= 10 && validation.ok && !submitting;

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(undefined);
    try {
      // With a wallet connected this fetch answers the 402 by asking the
      // wallet to sign the transfer and retrying. Without one the request
      // goes unpaid and comes back 402, which the error below explains. Both
      // servers behave that way now: the demo runs the same gate unless it is
      // started with `--free` or has no treasury configured.
      const res = await api.openMarket(
        {
          question: question.trim(),
          params,
          prior: priorPercent / 100,
          // The refund address. Whatever the market does not spend comes back
          // here, so it is the connected wallet or nothing.
          ...(wallet.accountId ? { askerAccountId: wallet.accountId } : {}),
        },
        wallet.payingFetch,
      );
      navigate(`/m/${res.marketId}`);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-lg font-semibold text-slate-100">Ask a question</h1>
        <p className="mt-1 text-sm text-slate-400">
          It should be a question with on-chain evidence and no definitive answer. Anything an
          oracle could settle does not need this mechanism.
        </p>
      </header>

      <Panel title="The question">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={3}
          placeholder="Is the last 30 days of TVL growth on this protocol organic?"
          className="w-full resize-none rounded border border-[var(--color-edge)] bg-black/30 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-slate-500"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => setQuestion(e)}
              className="rounded border border-[var(--color-edge)] px-2 py-1 text-[11px] text-slate-400 transition hover:border-slate-600 hover:text-slate-200"
            >
              {e.length > 46 ? `${e.slice(0, 46)}…` : e}
            </button>
          ))}
        </div>

        <label className="mt-4 block">
          <span className="text-xs text-slate-400">
            Opening price — where the market starts before anyone reports
          </span>
          <div className="mt-1 flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={99}
              value={priorPercent}
              onChange={(e) => setPriorPercent(Number(e.target.value))}
              className="flex-1 accent-slate-300"
            />
            <span className="w-14 text-right font-mono text-sm text-slate-100 tnum">
              {priorPercent}%
            </span>
          </div>
          <span className="mt-1 block text-[11px] text-slate-600">
            50% claims no prior knowledge, which is usually the honest starting point — and it is
            also the cheapest. The deposit bound is <code>b·max(−log q⁰)</code>, the worst case
            over where the reference agent lands, so opening confident costs more: if the market
            ends up on the side you called unlikely, the scoring rule has to pay for that whole
            move.
          </span>
        </label>
      </Panel>

      <Panel
        title="Mechanism parameters"
        aside={
          <button
            onClick={() => setAdvanced((a) => !a)}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            {advanced ? 'hide' : 'change'}
          </button>
        }
      >
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="k" value={params.k} hint="Last k agents take a flat fee instead of a score." mono />
          <Field label="T" value={params.T} hint="Target number of scored agents." mono />
          <Field label="α" value={params.alpha.toFixed(4)} hint="Chance the market closes after each report." mono />
          <Field label="ε" value={params.epsilon} hint="Reports are clipped into [ε, 1-ε]." mono />
        </dl>

        {advanced && (
          <div className="mt-5 grid gap-4 border-t border-[var(--color-edge)] pt-5 sm:grid-cols-3">
            <NumberField
              label="k — flat-fee tail"
              value={params.k}
              min={1}
              onChange={(k) => set({ k, alpha: suggestedAlpha(params.T, k) })}
              hint="Independent signals between an agent and the reference. Theorem 1 wants ~6; the demo runs 3."
            />
            <NumberField
              label="T — scored agents"
              value={params.T}
              min={1}
              onChange={(T) => set({ T, alpha: suggestedAlpha(T, params.k) })}
              hint="How many agents you want scored. Sets α = 1/(T+k)."
            />
            <NumberField
              label="α — stopping chance"
              value={params.alpha}
              step={0.005}
              min={0.001}
              max={0.999}
              onChange={(alpha) => set({ alpha })}
              hint={`Paper suggests 1/(T+k) = ${alphaSuggested.toFixed(4)}.`}
            />
            <NumberField
              label="b — liquidity"
              value={params.b}
              step={0.1}
              min={0.01}
              onChange={(b) => set({ b })}
              hint="Scoring scale. The whole CE-MSR subsidy is bounded by b·log2."
            />
            <NumberField
              label="R — flat fee"
              value={params.R}
              step={0.05}
              min={0}
              onChange={(R) => set({ R })}
              hint="Paid to each of the last k agents."
            />
            <NumberField
              label="minimum pool"
              value={params.minPoolSize}
              min={params.k + 2}
              onChange={(minPoolSize) => set({ minPoolSize })}
              hint="Below this the market cancels and refunds everyone."
            />
          </div>
        )}

        <div className="mt-5 grid gap-4 border-t border-[var(--color-edge)] pt-5 sm:grid-cols-3">
          <Field
            label="expected length"
            value={`${expectedLength(params).toFixed(1)} reports`}
            hint="1/α. The stopping rule is geometric, so this is a mean, not a cap."
          />
          <Field
            label="a report earns a flat fee"
            value={percent(1 - (1 - params.alpha) ** params.k)}
            hint="Chance an agent lands in the last k."
          />
          <Field
            label="pool runs dry"
            value={percent(exhaustion)}
            hint="(1-α)^(N-1). The one case where the last agent knows it is the reference."
          />
        </div>

        {validation.warnings.length > 0 && (
          <ul className="mt-4 space-y-1.5 rounded border border-amber-900/50 bg-amber-950/20 p-3">
            {validation.warnings.map((w) => (
              <li key={w} className="text-[11px] leading-snug text-amber-200/90">
                {w}
              </li>
            ))}
          </ul>
        )}
        {!validation.ok && (
          <ul className="mt-4 space-y-1.5 rounded border border-rose-900/50 bg-rose-950/20 p-3">
            {validation.errors.map((e) => (
              <li key={e} className="text-[11px] leading-snug text-rose-200/90">
                {e}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="What it costs you">
        {deposit ? (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-slate-400">Deposit</span>
              <span className="font-mono text-2xl font-semibold text-slate-100 tnum">
                {formatHbar(deposit.tinybar)}
              </span>
            </div>
            <dl className="mt-4 space-y-2 border-t border-[var(--color-edge)] pt-4 text-xs">
              <div className="flex justify-between">
                <dt className="text-slate-500">
                  b·max(−log q⁰) — the entire scoring subsidy, worst case over where the
                  reference lands
                </dt>
                <dd className="font-mono text-slate-300 tnum">
                  {deposit.scoringUnits.toFixed(4)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">k·R — flat fees for the last {params.k} agents</dt>
                <dd className="font-mono text-slate-300 tnum">{deposit.flatFeeUnits.toFixed(4)}</dd>
              </div>
              <div className="flex justify-between border-t border-[var(--color-edge)] pt-2">
                <dt className="text-slate-400">total, in mechanism units</dt>
                <dd className="font-mono text-slate-100 tnum">{deposit.units.toFixed(4)}</dd>
              </div>
            </dl>
            <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
              This is a ceiling, not a fee. Whatever the market does not spend comes back to you,
              and so does every penalty taken off an agent — losses are refunded to the asker
              rather than shared out, so no agent ever profits from another's mistake.
            </p>
          </>
        ) : (
          <p className="text-sm text-slate-500">Fix the parameters above to see the deposit.</p>
        )}
      </Panel>

      {error && (
        <ErrorBox
          title={
            error.isPaymentRequired
              ? 'This market needs payment before it opens.'
              : error.isUpstreamDown
                ? 'The payment rail is unreachable right now.'
                : 'Could not open the market.'
          }
          detail={
            error.isPaymentRequired
              ? wallet.status === 'connected'
                ? `The wallet at ${wallet.accountId} was asked to pay and the API still answered ` +
                  '402. Either the signature was rejected in the wallet, or the account is short ' +
                  'of the deposit above.'
                : wallet.status === 'unconfigured'
                  ? 'Opening a market costs the deposit above, paid over x402. The wallet button ' +
                    'is disabled because VITE_WALLETCONNECT_PROJECT_ID is not set.'
                  : 'Opening a market costs the deposit above, paid over x402. Connect a wallet ' +
                    'and try again.'
              : error.isUpstreamDown
                ? 'This is not a problem with your question. The x402 facilitator is not ' +
                  'answering; existing markets stay readable. Try again shortly.'
                : (error.detail ?? error.message)
          }
          retry={() => void submit()}
        />
      )}

      <div className="flex items-center justify-between">
        <p className="text-[11px] text-slate-600">
          {question.trim().length < 10
            ? 'Write a question of at least ten characters.'
            : wallet.status === 'connected'
              ? `Paid from ${wallet.accountId}, then written to a fresh HCS topic.`
              : 'The deposit is paid over x402 when you press this. Connect a wallet first, or the API answers 402.'}
        </p>
        <button
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
        >
          {submitting ? 'Opening…' : `Open market${deposit ? ` — ${formatHbar(deposit.tinybar, 2)}` : ''}`}
        </button>
      </div>
    </div>
  );
}
