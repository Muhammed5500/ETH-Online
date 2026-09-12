/**
 * In-memory state for markets and the agent registry.
 *
 * WHY IN MEMORY IS ENOUGH. HCS is the durable record — every report, close and
 * settlement is on the topic, and a market can be recomputed from it by
 * anybody (STEP 13). What lives here is the working copy the orchestrator
 * drives. Losing it costs a running market, not the history, and adding a
 * database before the mechanism is finished would be work spent on the wrong
 * problem.
 *
 * REGISTRATION IS OPEN, AND THAT IS A RULE, NOT A DEFAULT. PLAN section 3.3:
 * anyone may register an agent. This demo happens to seed the pool with twenty
 * agents we run, but nothing here knows that or depends on it. There is no
 * allowlist to remove later.
 */
import type { Belief, Market, MarketParams } from '@ethonline/core';
import type { HcsRandomSource } from '@ethonline/hedera';
import type { SettlementProgress } from './settlement-progress.js';

export interface RegisteredAgent {
  readonly agentId: string;
  /** Hedera account. Bonds are taken from it and payouts go to it. */
  readonly accountId: string;
  /** DER-encoded public key, used to check report signatures. */
  readonly publicKey: string;
  /** Where the orchestrator asks for a report (STEP 16). */
  readonly endpoint?: string;
  /** ENS subname, once STEP 25 has minted one. */
  readonly ensName?: string;
  /** Which Graph data slices this agent looks at (STEP 19). */
  readonly sliceIds?: readonly string[];
  readonly registeredAt: number;
}

/**
 * What an agent said about its own report, beside the report itself.
 *
 * `core` holds a report as a position, a belief and a clip. That is all the
 * mechanism scores and all it should ever hold — the package is pure and stays
 * that way. But a reader looking at a market wants to know what the agent was
 * looking at and what it paid to look, and that belongs somewhere. Here.
 *
 * None of it is signed and none of it is scored. It is an agent's account of
 * itself: useful to a person, worthless as proof. The one exception is
 * `evidenceDigest`, which does go on the HCS record, because a hash of the
 * evidence can be checked afterwards and prose cannot.
 */
export interface ReportAnnotation {
  readonly position: number;
  readonly agentId: string;
  readonly reasoning?: string;
  readonly sliceIds?: readonly string[];
  readonly evidenceCostUsd?: number;
  readonly evidenceDigest?: string;
}

export interface BondRecord {
  readonly agentId: string;
  readonly accountId: string;
  readonly paidTinybar: bigint;
  readonly bondedAt: number;
}

export interface StoredMarket {
  readonly id: string;
  readonly question: string;
  readonly topicId: string;
  readonly params: MarketParams;
  readonly prior: Belief;
  /** The state machine from `core`. The mechanism lives there, not here. */
  readonly market: Market;
  /** Fed by every HCS write; supplies the draws and the stopping dice. */
  readonly rng: HcsRandomSource;
  readonly depositTinybar: bigint;
  readonly bondTinybar: bigint;
  /**
   * Where the asker's refund goes.
   *
   * Declared by the caller when the market is opened, because the handler
   * cannot see who paid: the x402 gate settles after the handler returns, and
   * the payer's account only appears in the settlement receipt afterwards.
   *
   * Declaring it is not a hole worth closing with cryptography. The only thing
   * a liar can do is send their OWN refund somewhere else, and they have to
   * pay a full deposit for the privilege. Absent it, the market still runs and
   * settlement simply has nowhere to return the unspent deposit, which the
   * runner refuses to do silently.
   */
  readonly askerAccountId?: string;
  readonly createdAt: number;
  readonly bondingClosesAt: number;
  /**
   * The earliest the runner may close bonding, even with a full pool.
   *
   * Keeps the door open long enough for an agent that is not ours to see the
   * market and pay its way in. See ApiConfig.minBondingWindowMs.
   */
  readonly minBondingClosesAt: number;
  readonly bonds: Map<string, BondRecord>;
  /** Position to what the agent said about that report. Display only. */
  readonly annotations: Map<number, ReportAnnotation>;
  /**
   * Set on the first settlement attempt, then never recomputed.
   *
   * Mutable, unlike everything above it, because a settlement is the one thing
   * here that happens in stages: chunks are paid one transaction at a time and
   * the record of which ones landed has to survive between them. See
   * `settlement-progress.ts` for why re-deriving it instead would pay twice.
   */
  settlementProgress?: SettlementProgress;
}

export class AgentRegistry {
  private readonly agents = new Map<string, RegisteredAgent>();

  /**
   * Registers an agent, or updates its mutable fields.
   *
   * The account and public key are fixed at first registration. Letting them
   * change would let a registered agent hand its identity — and any bond
   * already posted under it — to a different key.
   */
  register(agent: RegisteredAgent): RegisteredAgent {
    const existing = this.agents.get(agent.agentId);
    if (existing) {
      if (existing.accountId !== agent.accountId || existing.publicKey !== agent.publicKey) {
        throw new Error(
          `Agent ${agent.agentId} is already registered with a different account or key. ` +
            `Identity is fixed at registration; register under a new agentId instead.`,
        );
      }
      const updated: RegisteredAgent = { ...existing, ...agent, registeredAt: existing.registeredAt };
      this.agents.set(agent.agentId, updated);
      return updated;
    }
    this.agents.set(agent.agentId, agent);
    return agent;
  }

  get(agentId: string): RegisteredAgent | undefined {
    return this.agents.get(agentId);
  }

  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  list(): RegisteredAgent[] {
    return [...this.agents.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  get size(): number {
    return this.agents.size;
  }
}

export class MarketStore {
  private readonly markets = new Map<string, StoredMarket>();
  /**
   * How many markets have ever been added, including removed ones.
   *
   * Ids are numbered from this rather than from `size` so a market that was
   * rolled back does not hand its number to the next one. Two topics sharing
   * an id would be indistinguishable in an HCS memo, and the second would be
   * refused by `add` if the first were still here — a bug that only appears
   * once a rollback has happened.
   */
  private issuedCount = 0;

  add(market: StoredMarket): StoredMarket {
    if (this.markets.has(market.id)) {
      throw new Error(`Market ${market.id} already exists.`);
    }
    this.markets.set(market.id, market);
    this.issuedCount++;
    return market;
  }

  get(id: string): StoredMarket | undefined {
    return this.markets.get(id);
  }

  /**
   * Drops a market that should never have existed.
   *
   * The one caller is the payment rollback: a market whose deposit did not
   * settle was opened by a handler that ran too early, and leaving it in the
   * store would let agents bond into a market nobody funded. Its HCS topic
   * stays behind with a lone `market-open` message, which is the honest
   * record of what happened.
   */
  remove(id: string): boolean {
    return this.markets.delete(id);
  }

  list(): StoredMarket[] {
    return [...this.markets.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get size(): number {
    return this.markets.size;
  }

  /** Markets ever added. Never goes down; see `issuedCount`. */
  get issued(): number {
    return this.issuedCount;
  }
}

/**
 * Market ids are readable and sortable rather than random.
 *
 * They end up in HCS memos, HashScan and demo narration, so `mkt-...-004`
 * beats a uuid when someone is reading a topic alongside a video.
 */
export function nextMarketId(count: number, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return `mkt-${date}-${String(count + 1).padStart(3, '0')}`;
}
