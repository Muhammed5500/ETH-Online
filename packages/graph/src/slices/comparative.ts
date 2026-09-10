/**
 * Comparative slice — the same question asked of several protocols at once.
 *
 * WHY THIS SLICE IS THE ARGUMENT FOR THE STANDARD. Every other slice could be
 * written against a bespoke subgraph with enough effort. This one could not.
 * It sends ONE query shape to five or more different protocols built by
 * different teams, and gets back comparable numbers — because they all
 * implement the same Messari schema. Without the standard this is five
 * integrations; with it, it is one string and a loop.
 *
 * That matters for the mechanism and not just for the pitch. "Is this growth
 * organic" has no absolute threshold. A turnover of 3 is unremarkable for a
 * stablecoin venue and absurd for a long-tail pool. The only way to say
 * anything defensible is to put the subject next to its peers, and the only
 * cheap way to do that is a shared schema.
 *
 * ONE PEER FAILING MUST NOT SINK THE SLICE. Peers are independent
 * deployments; one can be behind, broken or unindexed. A failed peer is
 * dropped, counted, and reported as a caveat. Throwing instead would mean an
 * agent loses its bond because somebody else's subgraph was down.
 */
import { GraphQueryError } from '../errors.js';
import type { GraphGateway } from '../gateway.js';
import {
  buildSummary,
  num,
  signal,
  type DataSlice,
  type QuestionContext,
  type SliceEvidence,
  type SliceSignal,
} from './types.js';
import { median, percentileRank, ratio } from './stats.js';

const SNAPSHOT_LIMIT = 7;

/**
 * The one query shape, sent unchanged to every protocol.
 *
 * `protocols` rather than `dexAmmProtocols` would be nicer still, but the
 * standard names the concrete type per vertical; this is the DEX one. The
 * fields below exist on every Messari DEX deployment.
 */
export const COMPARATIVE_QUERY = `
query ProtocolShape($snapshots: Int!) {
  dexAmmProtocols(first: 1) {
    id
    name
    slug
    network
    totalValueLockedUSD
    cumulativeVolumeUSD
    cumulativeTotalRevenueUSD
    cumulativeUniqueUsers
    totalPoolCount
  }
  financialsDailySnapshots(first: $snapshots, orderBy: timestamp, orderDirection: desc) {
    timestamp
    totalValueLockedUSD
    dailyVolumeUSD
    dailyTotalRevenueUSD
    dailySupplySideRevenueUSD
  }
  usageMetricsDailySnapshots(first: $snapshots, orderBy: timestamp, orderDirection: desc) {
    timestamp
    dailyActiveUsers
    dailyTransactionCount
  }
}`;

interface ProtocolRow {
  id?: string;
  name?: string;
  slug?: string;
  network?: string;
  totalValueLockedUSD?: string;
  cumulativeVolumeUSD?: string;
  cumulativeTotalRevenueUSD?: string;
  cumulativeUniqueUsers?: number;
  totalPoolCount?: number;
}

interface FinancialRow {
  timestamp?: string;
  totalValueLockedUSD?: string;
  dailyVolumeUSD?: string;
  dailyTotalRevenueUSD?: string;
  dailySupplySideRevenueUSD?: string;
}

interface UsageRow {
  timestamp?: string;
  dailyActiveUsers?: number;
  dailyTransactionCount?: number;
}

/** One protocol reduced to the handful of ratios that are comparable across all of them. */
export interface ProtocolProfile {
  readonly subgraphId: string;
  readonly name: string;
  readonly network: string | null;
  readonly tvlUsd: number | null;
  readonly dailyVolumeUsd: number | null;
  /** Daily volume over TVL. How hard the capital works. */
  readonly turnover: number | null;
  /** Daily revenue over TVL. What the capital actually earns. */
  readonly revenueYield: number | null;
  readonly dailyActiveUsers: number | null;
  /** TVL per active user. A very large value means few users hold a lot. */
  readonly tvlPerUser: number | null;
  readonly txPerUser: number | null;
  readonly poolCount: number | null;
}

export function profileFrom(
  subgraphId: string,
  data: {
    dexAmmProtocols?: ProtocolRow[];
    financialsDailySnapshots?: FinancialRow[];
    usageMetricsDailySnapshots?: UsageRow[];
  },
): ProtocolProfile {
  const protocol = data.dexAmmProtocols?.[0] ?? {};
  const financials = data.financialsDailySnapshots ?? [];
  const usage = data.usageMetricsDailySnapshots ?? [];

  // Medians rather than the newest day. The newest snapshot is often partial —
  // the current day is still being written — and a half-day of volume against
  // a full day of TVL understates turnover by roughly half.
  const tvl = median(financials.map((f) => num(f.totalValueLockedUSD))) ?? num(protocol.totalValueLockedUSD);
  const dailyVolume = median(financials.map((f) => num(f.dailyVolumeUSD)));
  const dailyRevenue = median(financials.map((f) => num(f.dailyTotalRevenueUSD)));
  const activeUsers = median(usage.map((u) => num(u.dailyActiveUsers)));
  const txCount = median(usage.map((u) => num(u.dailyTransactionCount)));

  return {
    subgraphId,
    name: protocol.name ?? protocol.slug ?? subgraphId,
    network: protocol.network ?? null,
    tvlUsd: tvl,
    dailyVolumeUsd: dailyVolume,
    turnover: ratio(dailyVolume, tvl),
    revenueYield: ratio(dailyRevenue, tvl),
    dailyActiveUsers: activeUsers,
    tvlPerUser: ratio(tvl, activeUsers),
    txPerUser: ratio(txCount, activeUsers),
    poolCount: num(protocol.totalPoolCount),
  };
}

export const comparativeSlice: DataSlice = {
  id: 'comparative',
  name: 'Comparative analyst',
  description:
    'The same standardized query across the subject and its peers, so its figures have somewhere to stand.',
  schema: 'dex-amm',

  async fetch(gateway: GraphGateway, ctx: QuestionContext): Promise<SliceEvidence> {
    const peers = ctx.peerSubgraphIds ?? [];
    const caveats: string[] = [];
    const sources: string[] = [];
    let cost = 0;
    let queryCount = 0;

    const run = async (id: string): Promise<ProtocolProfile | null> => {
      try {
        const result = await gateway.query<Parameters<typeof profileFrom>[1]>(
          id,
          COMPARATIVE_QUERY,
          { snapshots: SNAPSHOT_LIMIT },
        );
        queryCount++;
        cost += result.cost.usd ?? 0;
        sources.push(id);
        return profileFrom(id, result.data);
      } catch (e) {
        // A peer being down is a fact about that peer, not about the subject.
        const err = e as GraphQueryError;
        caveats.push(`Peer ${id} could not be read (${err.kind ?? 'unknown'}): ${err.message.slice(0, 120)}`);
        return null;
      }
    };

    // The subject is not optional. If it cannot be read there is nothing to
    // compare, and a comparison against nothing would be worse than no answer.
    const subject = await (async () => {
      const result = await gateway.query<Parameters<typeof profileFrom>[1]>(
        ctx.subgraphId,
        COMPARATIVE_QUERY,
        { snapshots: SNAPSHOT_LIMIT },
      );
      queryCount++;
      cost += result.cost.usd ?? 0;
      sources.push(ctx.subgraphId);
      return profileFrom(ctx.subgraphId, result.data);
    })();

    const peerProfiles = (await Promise.all(peers.map(run))).filter(
      (p): p is ProtocolProfile => p !== null,
    );

    if (peers.length === 0) {
      caveats.push(
        'No peers were configured, so the subject has nothing to be compared against and only ' +
          'its own figures are reported.',
      );
    } else if (peerProfiles.length < 4) {
      caveats.push(
        `Only ${peerProfiles.length} peers came back. Percentile ranks over a group this small ` +
          `are coarse.`,
      );
    }

    const column = (pick: (p: ProtocolProfile) => number | null): number[] =>
      peerProfiles.map(pick).filter((v): v is number => v !== null);

    const turnovers = column((p) => p.turnover);
    const yields = column((p) => p.revenueYield);
    const tvlPerUsers = column((p) => p.tvlPerUser);
    const txPerUsers = column((p) => p.txPerUser);

    const signals: SliceSignal[] = [
      signal('peers_compared', peerProfiles.length, 'count', 'peers that answered'),
      signal('subject_tvl', subject.tvlUsd, 'usd', 'median TVL over the snapshot span'),
      signal('subject_turnover', subject.turnover, 'ratio', 'daily volume over TVL'),
      signal(
        'peer_median_turnover',
        median(turnovers),
        'ratio',
        'the same measure across the peers',
      ),
      signal(
        'turnover_percentile',
        percentileRank(subject.turnover, turnovers),
        'share',
        'where the subject sits among its peers on turnover; 1 means higher than all of them',
      ),
      signal(
        'subject_revenue_yield',
        subject.revenueYield,
        'ratio',
        'daily revenue over TVL — what the capital actually earns',
      ),
      signal('peer_median_revenue_yield', median(yields), 'ratio', 'the same across the peers'),
      signal(
        'revenue_yield_percentile',
        percentileRank(subject.revenueYield, yields),
        'share',
        'high turnover with a low revenue-yield percentile is the signature of volume that ' +
          'pays no fees',
      ),
      signal(
        'subject_tvl_per_user',
        subject.tvlPerUser,
        'usd',
        'TVL divided by daily active users',
      ),
      signal(
        'tvl_per_user_percentile',
        percentileRank(subject.tvlPerUser, tvlPerUsers),
        'share',
        'where the subject sits on capital per user',
      ),
      signal(
        'tx_per_user_percentile',
        percentileRank(subject.txPerUser, txPerUsers),
        'share',
        'where the subject sits on transactions per user',
      ),
    ];

    const table = [subject, ...peerProfiles].map(
      (p, i) =>
        `  ${i === 0 ? '*' : ' '} ${p.name}: TVL $${(p.tvlUsd ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}, ` +
        `turnover ${p.turnover === null ? 'n/a' : p.turnover.toFixed(3)}, ` +
        `revenue yield ${p.revenueYield === null ? 'n/a' : p.revenueYield.toExponential(2)}, ` +
        `daily users ${p.dailyActiveUsers ?? 'n/a'}`,
    );

    return {
      sliceId: comparativeSlice.id,
      summary: buildSummary(
        `The same standardized query run against ${queryCount} protocols (* is the subject).`,
        table,
        signals,
        caveats,
      ),
      signals,
      raw: { subject, peers: peerProfiles },
      queryCostUsd: cost,
      sources,
      queryCount,
      caveats,
    };
  },
};
