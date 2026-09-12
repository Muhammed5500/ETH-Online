/**
 * An agent joining a market on its own initiative, and paying for it.
 *
 * WHAT WAS MISSING. Until now the only thing that ever posted a bond was a
 * gate script holding all twenty private keys and paying on everyone's behalf.
 * That proves the route works; it does not produce the product. In the product
 * an agent is a separate process that watches for markets, decides whether it
 * has anything to say, and pays its own bond with its own key — which is also
 * the only version a third party could ever run, since nobody else's keys are
 * in our accounts file.
 *
 * JOINING IS VOLUNTARY (PLAN section 3.3). `decideToBond` is asked first, and
 * an agent that declines simply never appears in that market. Nothing in the
 * protocol treats a missing agent as a fault: the bond is the entry, and not
 * bonding costs nothing.
 *
 * THE CEILING IS NOT DECORATION. A wrapped fetch pays whatever a 402 asks for.
 * The bond price comes from the market being joined, so a market that quotes
 * an absurd bond would otherwise drain an agent's account on the way past. The
 * watcher refuses anything above its own limit and says so.
 *
 * ONE ATTEMPT PER MARKET. A market that answered 402, 409 or anything else is
 * marked as seen either way. Retrying in a loop against a market that will
 * never accept us would spend real HBAR on repetition — and if the payment
 * settled and the response was merely lost, the retry would pay a second time
 * for a bond that is already posted.
 */
import type { Agent } from './runner.js';

/** Just enough of the market list for the decision. */
export interface MarketSummary {
  readonly marketId: string;
  readonly question: string;
  readonly status: string;
  /** Tinybar, as a string: it is a uint64 and would lose precision as a number. */
  readonly bondTinybar: string;
  readonly bondedCount: number;
  readonly minPoolSize?: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface BondingWatcherDeps {
  readonly agent: Agent;
  readonly agentId: string;
  /** Base URL of the API, e.g. `http://127.0.0.1:4020`. */
  readonly apiUrl: string;
  /**
   * A fetch that answers a 402 by paying it.
   *
   * Injected rather than built here: the tests hand it a plain fetch and never
   * touch a key, and the fleet hands it one wired to this agent's Hedera
   * account.
   */
  readonly payingFetch: FetchLike;
  /** Refuse any bond above this, in tinybar. */
  readonly maxBondTinybar: bigint;
  readonly onEvent?: (event: string, detail: Record<string, unknown>) => void;
}

export type BondOutcome =
  | 'bonded'
  | 'declined'
  | 'too-expensive'
  | 'refused'
  | 'error'
  /** Already acted on. See the one-attempt-per-market note above. */
  | 'skipped';

export class BondingWatcher {
  /** Markets already acted on, whatever the outcome. See the note above. */
  private readonly seen = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(private readonly deps: BondingWatcherDeps) {}

  private emit(event: string, detail: Record<string, unknown> = {}): void {
    this.deps.onEvent?.(event, detail);
  }

  /** Markets in `bonding` this agent has not looked at yet. */
  private async open(): Promise<MarketSummary[]> {
    const res = await fetch(`${this.deps.apiUrl}/markets`);
    if (!res.ok) throw new Error(`GET /markets answered ${res.status}`);
    const body = (await res.json()) as { markets?: MarketSummary[] };
    return (body.markets ?? []).filter((m) => m.status === 'bonding' && !this.seen.has(m.marketId));
  }

  /** Considers one market and, if it wants in, pays for it. */
  async consider(market: MarketSummary): Promise<BondOutcome> {
    // The guard lives here rather than only in the poll: paying twice for one
    // bond is the expensive mistake, so the check belongs next to the payment
    // and not next to the loop that usually calls it.
    if (this.seen.has(market.marketId)) return 'skipped';
    this.seen.add(market.marketId);

    if (!this.deps.agent.decideToBond(market.question)) {
      this.emit('bond-declined', { marketId: market.marketId, agentId: this.deps.agentId });
      return 'declined';
    }

    const price = BigInt(market.bondTinybar);
    if (price > this.deps.maxBondTinybar) {
      this.emit('bond-too-expensive', {
        marketId: market.marketId,
        agentId: this.deps.agentId,
        bondTinybar: market.bondTinybar,
        limitTinybar: this.deps.maxBondTinybar.toString(),
      });
      return 'too-expensive';
    }

    try {
      const res = await this.deps.payingFetch(
        `${this.deps.apiUrl}/market/${encodeURIComponent(market.marketId)}/bond`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: this.deps.agentId }),
        },
      );
      if (res.status === 201) {
        this.emit('bonded', {
          marketId: market.marketId,
          agentId: this.deps.agentId,
          paidTinybar: market.bondTinybar,
        });
        return 'bonded';
      }
      this.emit('bond-refused', {
        marketId: market.marketId,
        agentId: this.deps.agentId,
        status: res.status,
      });
      return 'refused';
    } catch (e) {
      this.emit('bond-error', {
        marketId: market.marketId,
        agentId: this.deps.agentId,
        error: (e as Error).message,
      });
      return 'error';
    }
  }

  /** One pass over everything currently open. */
  async tick(): Promise<BondOutcome[]> {
    let markets: MarketSummary[];
    try {
      markets = await this.open();
    } catch (e) {
      this.emit('bond-poll-failed', { agentId: this.deps.agentId, error: (e as Error).message });
      return [];
    }
    const outcomes: BondOutcome[] = [];
    for (const m of markets) outcomes.push(await this.consider(m));
    return outcomes;
  }

  start(intervalMs = 4000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void this.tick().finally(() => {
        this.busy = false;
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
