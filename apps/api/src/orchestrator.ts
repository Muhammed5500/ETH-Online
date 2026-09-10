/**
 * The orchestrator: drives a market from bonding to settled.
 *
 * THE ORDER INSIDE A ROUND IS THE WHOLE THING.
 *
 *   1. draw an agent          uses the running hash of the LAST message
 *   2. ask it for a report    over HTTP, with a deadline
 *   3. write the report       to HCS, which produces a NEW running hash
 *   4. roll the stopping dice from that new hash
 *
 * Step 4 must come after step 3. The dice have to come from the hash of the
 * report that was just written, because that hash did not exist until the
 * network reached consensus on it — that is the only reason nobody, including
 * us, could have known where the market would stop (STEP 14).
 *
 * A TIMEOUT IS NOT A ROUND. When an agent fails to answer, its bond is
 * slashed and it leaves the pool, but NO stopping dice are rolled. Otherwise
 * agents could close a market early simply by going quiet, which is a channel
 * anyone could pull on.
 *
 * A REPORT THAT ARRIVES BUT IS UNUSABLE COUNTS AS A TIMEOUT. A malformed
 * answer or a bad signature is slashed exactly like silence. If it were not,
 * an agent that disliked its position could send deliberate garbage, escape
 * being scored, and keep its bond — a free option out of the mechanism.
 */
import {
  beliefFromProbability,
  computeSettlement,
  requiredDeposit,
  type Belief,
  type MarketState,
  type Report,
  type Settlement,
} from '@ethonline/core';
import type { HcsMessage } from '@ethonline/hedera';
import type { Ledger } from './ledger.js';
import { verifyReportSignature } from './signatures.js';
import {
  buildTransferPlan,
  chunkPlan,
  type TransferLine,
  type TransferPlan,
} from './settlement-plan.js';
import type { AgentRegistry, MarketStore, StoredMarket, RegisteredAgent } from './store.js';

export interface ReportRequest {
  readonly marketId: string;
  readonly question: string;
  readonly position: number;
  readonly prior: Belief;
  /** Every earlier report. The equilibrium argument depends on agents seeing them. */
  readonly history: readonly Report[];
  readonly deadlineMs: number;
}

export interface AgentReportResponse {
  readonly probability: number;
  readonly signature: string;
  readonly reasoning?: string;
}

/** How the orchestrator reaches an agent. Injected so rounds can run offline. */
export interface AgentTransport {
  requestReport(agent: RegisteredAgent, req: ReportRequest): Promise<AgentReportResponse>;
}

export interface PayerReceipt {
  readonly transactionId: string;
  readonly status: string;
}

/** How money actually moves. Injected for the same reason. */
export interface Payer {
  send(lines: readonly TransferLine[], memo: string): Promise<PayerReceipt>;
}

export interface RoundResult {
  readonly position: number;
  readonly agentId: string;
  readonly outcome: 'reported' | 'timed-out';
  readonly belief?: Belief;
  readonly rawBelief?: Belief;
  readonly stopped: boolean;
  readonly sequenceNumber: number;
  readonly reason?: string;
}

export interface SettlementResult {
  readonly settlement: Settlement;
  readonly plan: TransferPlan;
  readonly receipts: readonly PayerReceipt[];
}

export interface OrchestratorDeps {
  readonly markets: MarketStore;
  readonly registry: AgentRegistry;
  readonly ledger: Ledger;
  readonly transport: AgentTransport;
  readonly payer: Payer;
  readonly hbarPerUnit: number;
  /** How long an agent has to answer. */
  readonly reportTimeoutMs?: number;
  readonly maxCreditsPerTransaction?: number;
  readonly now?: () => number;
  readonly onEvent?: (event: string, detail: Record<string, unknown>) => void;
}

export class Orchestrator {
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.reportTimeoutMs ?? 60_000;
  }

  private emit(event: string, detail: Record<string, unknown> = {}): void {
    this.deps.onEvent?.(event, detail);
  }

  private require(marketId: string): StoredMarket {
    const stored = this.deps.markets.get(marketId);
    if (!stored) throw new Error(`No such market: ${marketId}`);
    return stored;
  }

  /**
   * Closes the bonding window.
   *
   * Below `minPoolSize` the market is cancelled outright and everyone is
   * refunded. A market with too few agents is worse than no market: the pool
   * runs out almost immediately and the stopping time stops being
   * unpredictable, which is the assumption the whole mechanism rests on.
   */
  async closeBonding(marketId: string): Promise<'running' | 'cancelled'> {
    const stored = this.require(marketId);
    stored.market.closeBonding();
    const status = stored.market.status;
    this.emit('bonding-closed', { marketId, status, bonded: stored.bonds.size });
    return status === 'running' ? 'running' : 'cancelled';
  }

  /** Runs exactly one round. See the ordering note at the top of the file. */
  async runRound(marketId: string): Promise<RoundResult> {
    const stored = this.require(marketId);
    const { market, rng } = stored;

    const agentId = market.drawNextAgent();
    if (agentId === null) {
      throw new Error(`Market ${marketId} has no agents left to draw.`);
    }
    const position = market.reportCount + 1;
    this.emit('agent-drawn', { marketId, agentId, position });

    const agent = this.deps.registry.get(agentId);
    if (!agent) {
      return this.failRound(stored, agentId, position, 'Agent is no longer registered.');
    }

    let response: AgentReportResponse;
    try {
      response = await this.deps.transport.requestReport(agent, {
        marketId,
        question: stored.question,
        position,
        prior: stored.prior,
        history: market.getState().reports,
        deadlineMs: this.timeoutMs,
      });
    } catch (e) {
      return this.failRound(stored, agentId, position, `No usable answer: ${(e as Error).message}`);
    }

    const probability = Number(response.probability);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      return this.failRound(stored, agentId, position, 'Probability was not in [0, 1].');
    }

    // Signed over the raw value, before clipping — that is what the agent
    // committed to, and it keeps the clip auditable.
    const rawBelief = beliefFromProbability(probability);
    const check = verifyReportSignature(
      { marketId, agentId, position, belief: rawBelief },
      response.signature,
      agent.publicKey,
    );
    if (!check.ok) {
      return this.failRound(stored, agentId, position, `Bad signature: ${check.reason}`);
    }

    const report = market.submitReport(agentId, rawBelief);

    const appended = await this.deps.ledger.append(stored.topicId, {
      v: 1,
      type: 'report',
      marketId,
      ts: this.now(),
      position: report.position,
      agentId,
      belief: report.belief,
      rawBelief: report.rawBelief,
    });

    // The new hash first, THEN the dice. Reversing these two lines would make
    // the stopping decision predictable.
    rng.update(appended.runningHash);
    const stopped = market.rollStoppingDice();

    this.emit('report', {
      marketId,
      agentId,
      position: report.position,
      belief: report.belief[1],
      stopped,
    });

    if (stopped) await this.writeClose(stored);

    return {
      position: report.position,
      agentId,
      outcome: 'reported',
      belief: report.belief,
      rawBelief: report.rawBelief,
      stopped,
      sequenceNumber: appended.sequenceNumber,
    };
  }

  /**
   * Handles an agent that did not deliver a usable report.
   *
   * Bond slashed, agent dropped, ledger updated — and deliberately no dice.
   */
  private async failRound(
    stored: StoredMarket,
    agentId: string,
    position: number,
    reason: string,
  ): Promise<RoundResult> {
    // `core` records the timed-out agent on the market state itself; there is
    // no second list to keep in sync.
    stored.market.handleTimeout(agentId);

    const appended = await this.deps.ledger.append(stored.topicId, {
      v: 1,
      type: 'timeout',
      marketId: stored.id,
      ts: this.now(),
      position,
      agentId,
    });
    // Fresh entropy for the next draw, but no stopping roll: a timeout is not
    // a round, and letting one close a market would hand agents a lever.
    stored.rng.update(appended.runningHash);

    this.emit('timeout', { marketId: stored.id, agentId, position, reason });

    // `handleTimeout` closes the market itself if that was the last agent.
    if (stored.market.status === 'closed') await this.writeClose(stored);

    return {
      position,
      agentId,
      outcome: 'timed-out',
      stopped: stored.market.status === 'closed',
      sequenceNumber: appended.sequenceNumber,
      reason,
    };
  }

  private async writeClose(stored: StoredMarket): Promise<void> {
    const state = stored.market.getState();
    const close: HcsMessage = {
      v: 1,
      type: 'market-close',
      marketId: stored.id,
      ts: this.now(),
      reason: state.closedReason ?? 'stopping-rule',
      reportCount: state.reports.length,
      ...(state.referenceReport ? { reference: state.referenceReport.belief } : {}),
    };
    await this.deps.ledger.append(stored.topicId, close);
    this.emit('market-closed', {
      marketId: stored.id,
      reason: close.reason,
      reportCount: close.reportCount,
    });
  }

  /** Runs rounds until the market closes. */
  async runMarket(marketId: string): Promise<MarketState> {
    const stored = this.require(marketId);
    if (stored.market.status === 'bonding') await this.closeBonding(marketId);
    if (stored.market.status === 'cancelled') return stored.market.getState();

    // Every round removes exactly one agent from the pool, so the pool size is
    // a real bound. Kept explicit so a state-machine bug cannot spin forever.
    const maxRounds = stored.bonds.size + 1;
    for (let i = 0; i < maxRounds && stored.market.status === 'running'; i++) {
      await this.runRound(marketId);
    }
    if (stored.market.status === 'running') {
      throw new Error(`Market ${marketId} is still running after ${maxRounds} rounds.`);
    }
    return stored.market.getState();
  }

  /**
   * Settles: computes payouts, records them, then moves the money.
   *
   * The ledger entry is written BEFORE the transfers. If a transfer fails, the
   * settlement that was supposed to happen is already on the public record and
   * can be checked against what actually moved. The other order would let a
   * partial payout exist with nothing saying what it should have been.
   */
  async settle(marketId: string, askerAccountId: string): Promise<SettlementResult> {
    const stored = this.require(marketId);
    const state = stored.market.getState();
    if (state.status !== 'closed') {
      throw new Error(`Market ${marketId} is ${state.status}; only a closed market settles.`);
    }

    const depositUnits = requiredDeposit(stored.params, stored.prior);
    const settlement = computeSettlement(state, { deposit: depositUnits });

    const bondAccounts = new Map<string, string>();
    for (const [agentId, record] of stored.bonds) bondAccounts.set(agentId, record.accountId);

    const drawn = new Set(state.drawnAgents);
    const plan = buildTransferPlan({
      marketId,
      settlement,
      params: stored.params,
      hbarPerUnit: this.deps.hbarPerUnit,
      bondAccounts,
      timedOutAgents: state.timedOutAgents,
      notDrawnAgents: [...bondAccounts.keys()].filter((id) => !drawn.has(id)),
      askerAccountId,
      depositTinybar: stored.depositTinybar,
    });

    await this.deps.ledger.append(stored.topicId, {
      v: 1,
      type: 'settlement',
      marketId,
      ts: this.now(),
      ...(settlement.reference ? { reference: settlement.reference } : {}),
      payouts: settlement.payouts.map(
        (p) => [p.agentId, p.position, p.kind === 'scored' ? 's' : 'f', round6(p.amount)] as const,
      ),
      totals: {
        deposit: round6(settlement.deposit),
        totalBonds: round6(settlement.totalBonds),
        scoreTotal: round6(settlement.scoreTotal),
        bondsReturned: round6(settlement.bondsReturned),
        timeoutSlash: round6(settlement.timeoutSlash),
        scoreSlash: round6(settlement.scoreSlash),
        totalToAgents: round6(settlement.totalToAgents),
        askerRefund: round6(settlement.askerRefund),
      },
    });

    const receipts: PayerReceipt[] = [];
    const chunks = chunkPlan(plan, this.deps.maxCreditsPerTransaction ?? 9);
    for (const [i, chunk] of chunks.entries()) {
      receipts.push(await this.deps.payer.send(chunk, `${marketId} settlement ${i + 1}/${chunks.length}`));
    }

    stored.market.markSettled();
    this.emit('settled', {
      marketId,
      lines: plan.lines.length,
      totalOut: plan.totalOutTinybar.toString(),
      transactions: receipts.length,
    });

    return { settlement, plan, receipts };
  }
}

/**
 * Trims a float before it goes on the ledger.
 *
 * Six decimals is far finer than a tinybar at any sane scale, and it stops a
 * seventeen-digit float from eating the single-message budget (STEP 13).
 */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Total the treasury needs on hand before a settlement can be executed. */
export function treasuryRequirement(plan: TransferPlan): bigint {
  return plan.totalOutTinybar;
}
