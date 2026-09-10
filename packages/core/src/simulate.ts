/**
 * Simulation harness — runs a whole market off-chain, end to end.
 *
 * This is where the mechanism stops being a collection of formulas and starts
 * being a thing that behaves. Three behaviours matter, and each one is a claim
 * the demo makes out loud:
 *
 *   honest  the price walks toward the truth and honest agents get paid
 *   liar    moving the price away from where the market lands costs money
 *   lazy    copying the agent in front of you pays EXACTLY zero
 *
 * The third is the important one. It is Theorem 7 of the paper: the uninformed
 * equilibrium exists, but it pays nothing. There is no "collect a fee for
 * doing no work" hole in this mechanism, and that is rare enough in
 * single-task peer prediction that the paper calls it out. Here it is not an
 * argument, it is an assertion with a 1e-10 tolerance.
 *
 * Everything is deterministic given a seed: same seed, same market.
 */
import { assertValidParams, beliefFromProbability, normalizeBelief } from './config.js';
import { Market } from './market.js';
import { SeededRandom } from './random.js';
import { computeSettlement, type SettlementOptions } from './settlement.js';
import type { Belief, MarketParams, MarketState, Report, Settlement } from './types.js';

/**
 * An agent in a simulated market.
 *
 * It sees every earlier report and the opening prior, exactly like a real
 * agent does — the paper's equilibrium argument depends on that visibility.
 * Its own private signal is whatever the factory closed over.
 */
export interface SimAgent {
  readonly id: string;
  /** Produces a belief. The market clips it; the agent reports raw. */
  report(history: readonly Report[], prior: Belief): Belief;
}

export interface SimulationResult {
  readonly state: MarketState;
  readonly settlement: Settlement;
}

export interface SimulateOptions extends SettlementOptions {
  readonly id?: string;
  readonly question?: string;
}

/**
 * Runs one market to settlement.
 *
 * The loop is the same shape the on-chain orchestrator will have (STEP 16):
 * draw an agent, take its report, roll the stopping dice. Nothing here knows
 * about chains, so a failure in this file is a failure of the mechanism and
 * not of an integration.
 */
export function simulateMarket(
  params: MarketParams,
  agents: readonly SimAgent[],
  prior: Belief,
  seed: number,
  opts: SimulateOptions = {},
): SimulationResult {
  assertValidParams(params);

  const byId = new Map(agents.map((a) => [a.id, a]));
  if (byId.size !== agents.length) {
    throw new Error('Agent ids must be unique — one agent joins a market at most once.');
  }
  if (agents.length < params.minPoolSize) {
    throw new Error(
      `Need at least minPoolSize=${params.minPoolSize} agents to run a market, ` +
        `got ${agents.length}. Below that the market is cancelled and everyone is ` +
        `refunded, so there is nothing to settle.`,
    );
  }

  const market = Market.create(
    {
      id: opts.id ?? `sim-${seed}`,
      question: opts.question ?? 'simulated market',
      params,
      prior,
    },
    new SeededRandom(seed),
  );

  for (const a of agents) market.addBondedAgent(a.id);
  market.closeBonding();

  const state = market.getState();

  // Draw, report, roll. `rollStoppingDice` force-closes on an empty pool, so
  // the loop always terminates: every round removes one agent from the pool.
  while (market.status === 'running') {
    const agentId = market.drawNextAgent();
    if (agentId === null) break;

    const agent = byId.get(agentId)!;
    const raw = agent.report(state.reports, prior);
    market.submitReport(agentId, normalizeBelief(raw));
    market.rollStoppingDice();
  }

  const settlement = computeSettlement(state, opts);
  return { state, settlement };
}

// --------------------------------------------------------------- scenarios

/** Current market price: the last report, or the prior if nobody has spoken. */
function priceOf(history: readonly Report[], prior: Belief): number {
  const last = history[history.length - 1];
  return last ? last.belief[1] : prior[1];
}

export interface HonestAgentOptions {
  readonly id: string;
  /** The hidden P(Y=1) every honest agent is noisily observing. */
  readonly truth: number;
  /** Half-width of the uniform noise on this agent's private signal. */
  readonly noise?: number;
  /** Seeds this agent's private signal. Different seeds -> independent signals. */
  readonly seed: number;
  /**
   * How far the agent pulls the price toward its own signal, in [0, 1].
   *
   * Deliberately a constant rather than the `1/(t+1)` a naive Bayesian would
   * use. That decaying weight assumes every earlier report was honest, so the
   * longer the market runs the less an agent trusts its own evidence. It has a
   * failure mode we measured: agents go inert, a single liar knocks the price
   * off the truth, and nobody left in the market can pull it back — the market
   * then closes near the lie and the liar gets PAID for having moved the price
   * toward the reference.
   *
   * A constant weight keeps every agent able to correct the record no matter
   * how late it is drawn, which is the property the mechanism needs and the
   * one the demo claims.
   */
  readonly selfWeight?: number;
}

/**
 * Draws one private signal, once, at construction.
 *
 * That is deliberate: in the paper an agent HAS a signal, it does not resample
 * one when it happens to be drawn. Seeding per agent rather than per market
 * also keeps signals independent of draw order, which is what Assumption 4
 * (conditional independence) asks for — and what the real system buys by
 * giving every agent a different data slice.
 */
function drawSignal(truth: number, noise: number, seed: number): number {
  const u = new SeededRandom(seed).next('signal');
  const s = truth + (u * 2 - 1) * noise;
  return Math.min(0.99, Math.max(0.01, s));
}

/**
 * Honest agent: pulls the market price partway toward its own private signal.
 *
 *   `q = (1 - w)·price + w·signal`
 *
 * The first agent has no price to blend with, so it reports its raw signal and
 * moves the market off the prior.
 *
 * With every agent honest this is an exponential moving average of independent
 * signals, so the price settles around their mean, which is the truth. With a
 * liar in the pool it is also self-correcting: whoever is drawn next pulls a
 * fixed fraction of the way back, so a lie is walked off within a few reports
 * instead of standing until the market closes.
 */
export function makeHonestAgent(opts: HonestAgentOptions): SimAgent {
  const signal = drawSignal(opts.truth, opts.noise ?? 0.2, opts.seed);
  const w = opts.selfWeight ?? 0.4;
  if (!(w > 0 && w <= 1)) {
    throw new Error(`selfWeight must be in (0, 1], got: ${w}`);
  }
  return {
    id: opts.id,
    report(history, prior) {
      // Nothing to blend with on the first report.
      const weight = history.length === 0 ? 1 : w;
      const p1 = (1 - weight) * priceOf(history, prior) + weight * signal;
      return beliefFromProbability(p1);
    },
  };
}

/**
 * Liar: works out the honest belief, then reports its mirror image.
 *
 * It is not reporting noise — it is reporting a confident wrong answer, which
 * is the expensive kind. Moving the price away from where the market lands
 * makes `S_CEM` negative, and that comes out of the bond.
 */
export function makeLiarAgent(opts: HonestAgentOptions): SimAgent {
  const honest = makeHonestAgent(opts);
  return {
    id: opts.id,
    report(history, prior) {
      const p1 = honest.report(history, prior)[1];
      return beliefFromProbability(1 - p1);
    },
  };
}

export interface LazyAgentOptions {
  readonly id: string;
  /**
   * What to report with nothing to copy.
   *
   * Defaults to the prior, which makes the whole market pay zero. Pass
   * something else to get the paper's non-degenerate uninformed equilibrium:
   * the first agent captures `KL(r || prior)` and every copier after it gets
   * exactly nothing.
   */
  readonly whenFirst?: Belief;
}

/** Lazy agent: copies the report in front of it, verbatim. */
export function makeLazyAgent(opts: LazyAgentOptions): SimAgent {
  return {
    id: opts.id,
    report(history, prior) {
      const last = history[history.length - 1];
      if (last) return last.belief;
      return opts.whenFirst ?? prior;
    },
  };
}

// ------------------------------------------------------------------ helpers

/** Builds `count` honest agents with independent signals. */
export function honestPool(
  count: number,
  truth: number,
  seedBase: number,
  noise?: number,
): SimAgent[] {
  return Array.from({ length: count }, (_, i) =>
    makeHonestAgent({
      id: `honest-${String(i + 1).padStart(2, '0')}`,
      truth,
      seed: seedBase + i,
      noise,
    }),
  );
}

/** The market's closing price, i.e. the reference agent's report. */
export function closingPrice(state: MarketState): Belief {
  return state.referenceReport?.belief ?? state.prior;
}
