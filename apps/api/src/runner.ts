/**
 * The thing that makes a market actually run.
 *
 * WHAT WAS MISSING. `createApp` answers routes and `Orchestrator` drives one
 * market, but nothing connected the two: a market opened through `POST /market`
 * on the real server sat at `bonding` forever, because every run so far had a
 * script standing over it calling `closeBonding`, `runMarket` and `settle` by
 * hand. The demo server had a pickup loop; the product did not. This is that
 * loop, in the shipped path.
 *
 * WHEN BONDING CLOSES, AND WHY THE TWO CASES DIFFER.
 *
 *   pool full     close and run, but never before the minimum bonding window
 *                 has passed. Ours fills in seconds; closing on that alone
 *                 would shut the door before anybody else's agent had seen
 *                 the market at all.
 *   window over,  the market cannot run: below `minPoolSize` the pool empties
 *   pool short    almost at once and the stopping time stops being
 *                 unpredictable, which is the assumption the mechanism rests
 *                 on. `core` cancels it, and the money has to go back. That
 *                 refund is executed here, not left for a person to remember.
 *
 * ONE MARKET AT A TIME. Rounds are sequential by construction — every agent
 * must see every earlier report — but two different markets could in principle
 * run at once. They do not, because both would draw from the same treasury and
 * settle against it, and interleaved settlements make the treasury's balance
 * impossible to reason about while either is in flight. A queue costs latency
 * that nobody in this system can measure.
 *
 * FAILURE IS RECORDED, NOT RETRIED BLINDLY. A market that throws while running
 * is marked as handled and left in whatever state it reached. Re-running a
 * half-run market would draw agents twice; a settlement that stopped partway
 * is resumable on its own terms (`settlement-progress.ts`) and needs a person.
 */
import type { Orchestrator } from './orchestrator.js';
import type { MarketStore, StoredMarket } from './store.js';

export interface MarketRunnerDeps {
  readonly markets: MarketStore;
  readonly orchestrator: Orchestrator;
  /** Executes the refund for a market that never reached `minPoolSize`. */
  readonly refund?: (market: StoredMarket) => Promise<void>;
  readonly now?: () => number;
  readonly onEvent?: (event: string, detail: Record<string, unknown>) => void;
}

export type RunOutcome =
  | 'waiting'
  | 'ran'
  | 'cancelled'
  | 'failed'
  /** Ran, but the refund had nowhere to go. Money is still in the treasury. */
  | 'unsettled';

export class MarketRunner {
  private readonly now: () => number;
  /** Markets this runner has taken responsibility for, so none is run twice. */
  private readonly handled = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(private readonly deps: MarketRunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private emit(event: string, detail: Record<string, unknown> = {}): void {
    this.deps.onEvent?.(event, detail);
  }

  /** Everything still waiting for its pool to fill. */
  private pending(): StoredMarket[] {
    return this.deps.markets
      .list()
      .filter((m) => !this.handled.has(m.id) && m.market.status === 'bonding');
  }

  /**
   * One pass. Runs at most one market, so a slow round never overlaps another
   * market's settlement.
   */
  async tick(): Promise<RunOutcome> {
    for (const stored of this.pending()) {
      const full = stored.bonds.size >= stored.params.minPoolSize;
      const expired = this.now() >= stored.bondingClosesAt;
      // A full pool is not enough on its own. Ours fills in seconds, and
      // closing on it would make "registration is open to anyone" true in the
      // code and false in practice — see ApiConfig.minBondingWindowMs.
      const doorMayClose = this.now() >= stored.minBondingClosesAt;
      if (!expired && !(full && doorMayClose)) continue;

      this.handled.add(stored.id);
      return full ? this.run(stored) : this.cancel(stored);
    }
    return 'waiting';
  }

  private async run(stored: StoredMarket): Promise<RunOutcome> {
    this.emit('runner-start', {
      marketId: stored.id,
      question: stored.question,
      bonded: stored.bonds.size,
    });

    try {
      await this.deps.orchestrator.closeBonding(stored.id);
      const state = await this.deps.orchestrator.runMarket(stored.id);
      this.emit('runner-closed', {
        marketId: stored.id,
        reports: state.reports.length,
        reason: state.closedReason,
        price: state.referenceReport?.belief[1],
      });

      // No account, no settlement. Paying the refund to a guess would be
      // worse than leaving it: the treasury holds it, the settlement message
      // is not on the topic yet, and it can be settled by hand once the asker
      // says where it should go.
      if (!stored.askerAccountId) {
        this.emit('runner-unsettled', {
          marketId: stored.id,
          reason: 'the market was opened without an askerAccountId',
        });
        return 'unsettled';
      }

      const result = await this.deps.orchestrator.settle(stored.id, stored.askerAccountId);
      this.emit('runner-settled', {
        marketId: stored.id,
        transactions: result.receipts.length,
        totalOut: result.plan.totalOutTinybar.toString(),
      });
      return 'ran';
    } catch (e) {
      this.emit('runner-failed', { marketId: stored.id, error: (e as Error).message });
      return 'failed';
    }
  }

  /**
   * The pool never filled: cancel and give everything back.
   *
   * `closeBonding` on a short pool puts the market in `cancelled`, which has
   * no settlement — there is nothing to score. What there is, is money: the
   * asker's deposit and every bond posted so far.
   */
  private async cancel(stored: StoredMarket): Promise<RunOutcome> {
    this.emit('runner-cancelling', {
      marketId: stored.id,
      bonded: stored.bonds.size,
      needed: stored.params.minPoolSize,
    });
    try {
      await this.deps.orchestrator.closeBonding(stored.id);
      if (this.deps.refund) await this.deps.refund(stored);
      else
        this.emit('runner-unsettled', {
          marketId: stored.id,
          reason: 'cancelled, and no refund executor is configured',
        });
      return 'cancelled';
    } catch (e) {
      this.emit('runner-failed', { marketId: stored.id, error: (e as Error).message });
      return 'failed';
    }
  }

  /** Polls until stopped. `unref` so it never holds a process open by itself. */
  start(intervalMs = 3000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void this.tick()
        .catch((e: unknown) => this.emit('runner-failed', { error: (e as Error).message }))
        .finally(() => {
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
