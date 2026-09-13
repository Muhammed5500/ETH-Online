/**
 * The resolution service — STEP 22.
 *
 * WHAT IS BEING SOLD. Not a subscription and not an API key: one answer, paid
 * for per call in HBAR over x402. A caller asks a question, pays, and gets the
 * market's price for it back along with everything needed to check that the
 * price came from a market that actually ran.
 *
 * WHY A CACHE HIT AND A MISS ANSWER DIFFERENTLY, AND WHY THAT IS NOT A DODGE.
 * Running the mechanism means twenty agents bonding, a sequence of rounds each
 * with an HCS write and consensus, and a settlement. On testnet that is a
 * hundred seconds and change — measured in STEP 17 — which no HTTP client will
 * wait for and no reverse proxy will allow. So:
 *
 *   a question already answered   200, the answer, immediately
 *   a market running on it        202, the market id, and where to watch it
 *   no market at all              404, and how to open one. NOTHING IS CHARGED
 *
 * WHY THIS ROUTE NEVER OPENS A MARKET. It used to. A market costs a deposit of
 * `b·H(prior) + k·R`, while this route charges a flat fee, so opening one here
 * funded settlement with a deposit nobody had paid, and the parameters came
 * from the request body, so a caller could raise `b` and have the treasury pay
 * out a subsidy hundreds of times the fee. Opening a market is `POST /market`,
 * which prices the deposit from the same body the handler uses. A 404 here is
 * a 4xx, and `@x402/express` cancels settlement for any handler status >= 400,
 * so asking about an unknown question costs the caller nothing.
 *
 * The alternative designs are both worse. Blocking the request would time out
 * and charge for nothing. Returning a model's guess while a market runs in the
 * background would sell an answer the mechanism never produced, which is the
 * one thing this service must never do.
 *
 * THE ANSWER CARRIES ITS OWN PROOF. Every report is on an HCS topic and the
 * topic id travels with the answer, so a buyer can read the same sequence from
 * a public mirror node and recompute the closing price without trusting this
 * server at all. An answer that cannot be checked is worth what an oracle is
 * worth, which is precisely what this whole mechanism exists to avoid.
 */
import { mirrorNodeUrl, type HederaNetwork } from '@ethonline/hedera';
import type { AgentRegistry, MarketStore, ReportAnnotation, StoredMarket } from './store.js';

/**
 * Normalizes a question for cache lookup.
 *
 * Case, surrounding space, runs of whitespace and trailing punctuation are
 * noise; two buyers asking the same thing should not each pay for a market.
 * Nothing more aggressive than that — stemming or synonym matching would sell
 * an answer to a question nobody asked, and the buyer has no way to tell.
 */
export function questionKey(question: string): string {
  return question
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[?!.\s]+$/, '');
}

/**
 * A market that has already answered this question, if there is one.
 *
 * `closed` counts as well as `settled`: the price is fixed the moment the
 * reference report exists, and whether the payouts have landed is an
 * accounting question that does not change the answer. A market with no
 * reference — everyone timed out — answered nothing and is skipped.
 */
export function findAnsweredMarket(
  markets: MarketStore,
  question: string,
): StoredMarket | undefined {
  const key = questionKey(question);
  return markets.list().find((m) => {
    if (questionKey(m.question) !== key) return false;
    const state = m.market.getState();
    return (
      (state.status === 'settled' || state.status === 'closed') &&
      state.referenceReport !== undefined
    );
  });
}

/** A market already running for this question, so a buyer is not charged twice. */
export function findPendingMarket(
  markets: MarketStore,
  question: string,
): StoredMarket | undefined {
  const key = questionKey(question);
  return markets.list().find((m) => {
    if (questionKey(m.question) !== key) return false;
    const status = m.market.getState().status;
    return status === 'bonding' || status === 'running';
  });
}

export interface AgentBreakdownEntry {
  readonly agentId: string;
  readonly position: number;
  readonly belief: readonly [number, number];
  readonly ensName?: string;
  readonly sliceIds?: readonly string[];
  readonly reasoning?: string;
  /** True for the terminal report, which is the one everyone was scored against. */
  readonly isReference: boolean;
}

export interface ResolveAnswer {
  readonly marketId: string;
  readonly question: string;
  /** The closing price: the reference agent's P(yes). */
  readonly probability: number;
  readonly reportCount: number;
  readonly agentBreakdown: readonly AgentBreakdownEntry[];
  /** What the agents spent on Graph queries to produce this. */
  readonly evidenceCostUsd: number;
  readonly marketStatus: string;
  readonly closedReason?: string;
  /** Everything needed to recompute this answer from public data. */
  readonly verify: {
    readonly hcsTopicId: string;
    readonly mirrorUrl: string;
    readonly network: string;
  };
}

export interface BuildAnswerOptions {
  readonly network: HederaNetwork;
  readonly registry?: AgentRegistry;
}

/**
 * Assembles the answer from a closed market.
 *
 * The breakdown is included rather than just the number because a single
 * probability is not checkable. Seeing that eight agents looked at different
 * slices and converged is the difference between an answer and an assertion —
 * and every line of it can be read back off the topic.
 */
export function buildResolveAnswer(
  stored: StoredMarket,
  opts: BuildAnswerOptions,
): ResolveAnswer {
  const state = stored.market.getState();
  const reference = state.referenceReport;
  if (!reference) {
    throw new Error(
      `Market ${stored.id} has no reference report and therefore no answer. ` +
        `findAnsweredMarket should have excluded it.`,
    );
  }

  const annotation = (position: number): ReportAnnotation | undefined =>
    stored.annotations.get(position);

  const breakdown: AgentBreakdownEntry[] = state.reports.map((r) => {
    const note = annotation(r.position);
    const registered = opts.registry?.get(r.agentId);
    return {
      agentId: r.agentId,
      position: r.position,
      belief: r.belief,
      ...(registered?.ensName ? { ensName: registered.ensName } : {}),
      ...(note?.sliceIds ? { sliceIds: note.sliceIds } : {}),
      ...(note?.reasoning ? { reasoning: note.reasoning } : {}),
      isReference: r.position === reference.position,
    };
  });

  const evidenceCostUsd = state.reports.reduce(
    (sum, r) => sum + (annotation(r.position)?.evidenceCostUsd ?? 0),
    0,
  );

  return {
    marketId: stored.id,
    question: stored.question,
    probability: reference.belief[1],
    reportCount: state.reports.length,
    agentBreakdown: breakdown,
    // Six decimals: the same rounding contract the HCS ledger uses, so a sum
    // published here and a sum recomputed from the topic agree exactly.
    evidenceCostUsd: Math.round(evidenceCostUsd * 1e6) / 1e6,
    marketStatus: state.status,
    ...(state.closedReason ? { closedReason: state.closedReason } : {}),
    verify: {
      hcsTopicId: stored.topicId,
      mirrorUrl: `${mirrorNodeUrl(opts.network)}/api/v1/topics/${stored.topicId}/messages`,
      network: opts.network,
    },
  };
}
