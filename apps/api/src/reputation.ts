/**
 * What an agent has actually done, counted from the markets themselves.
 *
 * WHY THIS IS NOT ENS. The roadmap put an agent's identity and its record in
 * ENS text records, and ENS is not built. But the record was never really an
 * identity problem: every report, every reference and every payout is already
 * on an HCS topic, and the server holds the same markets in memory. Reading it
 * back is arithmetic over what happened, not a lookup of what somebody wrote
 * about themselves — which is the stronger version of the same page.
 *
 * WHAT IS COUNTED AND WHAT IS DELIBERATELY NOT.
 *
 *   bonded      markets this agent paid to join. The bond record is the
 *               authority, not `bondedAgents` on the state: that list shrinks
 *               as agents are drawn, so counting it would forget everyone who
 *               actually played.
 *   reported    reports it delivered.
 *   reference   times it was the terminal agent, the one everybody else was
 *               scored against. Nothing about that is skill — the stopping
 *               dice decide it — so it is shown as a fact, never as a rank.
 *   timedOut    times it was drawn and failed to answer. Its whole bond was
 *               slashed each time.
 *   net         sum of its payouts, in mechanism units. Negative is a real
 *               outcome, not an error: an agent that moved the price away from
 *               where the market ended pays for it out of its bond.
 *
 * There is no average score and no leaderboard. Scores are not comparable
 * across markets — a market with a `b` twice as large pays twice as much for
 * the same move — and ranking twenty agents by a number that means different
 * things per market would be an invented statistic dressed as a record.
 */
import type { MarketStore } from './store.js';

export interface AgentRecord {
  /** Markets whose bond this agent paid. */
  readonly bonded: number;
  readonly reported: number;
  /** Times it was the terminal report everyone was scored against. */
  readonly reference: number;
  /** Times it was drawn and did not answer. Bond slashed in full. */
  readonly timedOut: number;
  /** Times it was among the last k, taking the flat fee instead of a score. */
  readonly flatFee: number;
  /** Net of every payout, in mechanism units. May be negative. */
  readonly net: number;
  /** Only counts markets that have been settled; the rest have no payouts yet. */
  readonly settledMarkets: number;
}

const EMPTY: AgentRecord = {
  bonded: 0,
  reported: 0,
  reference: 0,
  timedOut: 0,
  flatFee: 0,
  net: 0,
  settledMarkets: 0,
};

/**
 * Builds every agent's record in one pass over the markets.
 *
 * A map rather than a per-agent query: the directory needs all twenty at once,
 * and twenty separate walks over the same markets would be the same work
 * twenty times.
 */
export function agentRecords(markets: MarketStore): Map<string, AgentRecord> {
  const records = new Map<string, AgentRecord>();
  const bump = (agentId: string, patch: Partial<AgentRecord>): void => {
    const current = records.get(agentId) ?? EMPTY;
    records.set(agentId, {
      bonded: current.bonded + (patch.bonded ?? 0),
      reported: current.reported + (patch.reported ?? 0),
      reference: current.reference + (patch.reference ?? 0),
      timedOut: current.timedOut + (patch.timedOut ?? 0),
      flatFee: current.flatFee + (patch.flatFee ?? 0),
      net: current.net + (patch.net ?? 0),
      settledMarkets: current.settledMarkets + (patch.settledMarkets ?? 0),
    });
  };

  for (const stored of markets.list()) {
    for (const agentId of stored.bonds.keys()) bump(agentId, { bonded: 1 });

    const state = stored.market.getState();
    for (const report of state.reports) bump(report.agentId, { reported: 1 });
    for (const agentId of state.timedOutAgents) bump(agentId, { timedOut: 1 });
    if (state.referenceReport) bump(state.referenceReport.agentId, { reference: 1 });

    // Payouts exist only once a settlement has been computed. A market that
    // closed a second ago has a price and no payments, and showing a net of
    // zero for it would read as "scored nothing" rather than "not yet scored".
    const settlement = stored.settlementProgress?.settlement;
    if (!settlement) continue;
    for (const payout of settlement.payouts) {
      bump(payout.agentId, {
        net: payout.amount,
        settledMarkets: 1,
        ...(payout.kind === 'flat-fee' ? { flatFee: 1 } : {}),
      });
    }
  }

  return records;
}

/** One agent's record, or an empty one for an agent that has never played. */
export function recordFor(records: ReadonlyMap<string, AgentRecord>, agentId: string): AgentRecord {
  return records.get(agentId) ?? EMPTY;
}
