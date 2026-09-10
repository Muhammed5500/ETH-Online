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
  readonly createdAt: number;
  readonly bondingClosesAt: number;
  readonly bonds: Map<string, BondRecord>;
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

  add(market: StoredMarket): StoredMarket {
    if (this.markets.has(market.id)) {
      throw new Error(`Market ${market.id} already exists.`);
    }
    this.markets.set(market.id, market);
    return market;
  }

  get(id: string): StoredMarket | undefined {
    return this.markets.get(id);
  }

  list(): StoredMarket[] {
    return [...this.markets.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get size(): number {
    return this.markets.size;
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
