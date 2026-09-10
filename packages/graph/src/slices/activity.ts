/**
 * Activity slice — the shape of the traffic, not its size.
 *
 * Every other slice measures amounts. This one deliberately measures TIMING
 * and REPETITION, because that is where scripted volume gives itself away and
 * because it keeps this slice's signal genuinely separate from the rest — the
 * point of Assumption 4.
 *
 * The strongest single signal in this file is the self-trade share. The
 * Messari `Swap` entity carries both `from` and `to`, and a swap where those
 * are the same address is one wallet trading with itself. There are innocent
 * explanations for a few of them, routers and aggregators among them. There is
 * no innocent explanation for a third of the tape.
 *
 * Second is the coefficient of variation of inter-arrival times. Human demand
 * is bursty and lands somewhere near or above 1. A timer produces something
 * near 0. This is the measure that distinguishes a busy protocol from a loop.
 *
 * NOTE ON GAS. The roadmap's sketch for this slice mentioned gas patterns.
 * The Messari standard does not carry gas: the `Event` interface has `hash`,
 * `logIndex`, `to`, `from`, `blockNumber` and `timestamp`, and nothing else.
 * Rather than fall off the standard for one field — which would cost the
 * cross-protocol leverage every slice depends on — the timing and repetition
 * measures below stand in for it.
 */
import type { GraphGateway } from '../gateway.js';
import {
  buildSummary,
  num,
  signal,
  windowStart,
  type DataSlice,
  type QuestionContext,
  type SliceEvidence,
  type SliceSignal,
} from './types.js';
import {
  coefficientOfVariation,
  hourConcentration,
  interArrivalGaps,
  mean,
  median,
  oneShotShare,
  ratio,
  roundNumberShare,
  sum,
  topNShare,
  sumByKey,
  uniqueCount,
} from './stats.js';

const SWAP_LIMIT = 1000;
const SNAPSHOT_LIMIT = 30;

export const ACTIVITY_QUERY = `
query ActivityShape($first: Int!, $snapshots: Int!, $since: BigInt!) {
  swaps(
    first: $first
    orderBy: timestamp
    orderDirection: desc
    where: { timestamp_gte: $since }
  ) {
    id
    from
    to
    timestamp
    blockNumber
    amountInUSD
    amountOutUSD
    pool { id }
  }
  usageMetricsDailySnapshots(first: $snapshots, orderBy: timestamp, orderDirection: desc) {
    timestamp
    dailyActiveUsers
    dailyTransactionCount
    dailySwapCount
  }
}`;

interface SwapRow {
  id?: string;
  from?: string;
  to?: string;
  timestamp?: string;
  blockNumber?: string;
  amountInUSD?: string;
  amountOutUSD?: string;
  pool?: { id?: string };
}

interface UsageRow {
  timestamp?: string;
  dailyActiveUsers?: number;
  dailyTransactionCount?: number;
  dailySwapCount?: number;
}

export const activitySlice: DataSlice = {
  id: 'activity',
  name: 'Transaction pattern analyst',
  description:
    'Timing regularity, self-trades, repeated senders and round amounts — the shape of the tape.',
  schema: 'dex-amm',

  async fetch(gateway: GraphGateway, ctx: QuestionContext): Promise<SliceEvidence> {
    const since = windowStart(ctx);
    const result = await gateway.query<{
      swaps?: SwapRow[];
      usageMetricsDailySnapshots?: UsageRow[];
    }>(ctx.subgraphId, ACTIVITY_QUERY, {
      first: SWAP_LIMIT,
      snapshots: SNAPSHOT_LIMIT,
      since: String(since),
    });

    const swaps = result.data.swaps ?? [];
    const usage = result.data.usageMetricsDailySnapshots ?? [];
    const caveats: string[] = [];

    if (swaps.length === 0) caveats.push('No swaps fell inside the window.');
    if (swaps.length === SWAP_LIMIT) {
      caveats.push(
        `Hit the ${SWAP_LIMIT}-swap page limit. Timing figures describe the most recent ` +
          `${SWAP_LIMIT} swaps, which on a busy protocol may be a short slice of the window.`,
      );
    }
    if (swaps.length > 0 && swaps.length < 30) {
      caveats.push(
        `Only ${swaps.length} swaps to work with. Timing statistics over a set this small are ` +
          `weak evidence either way.`,
      );
    }
    caveats.push(
      'The Messari standard carries no gas field, so gas patterns are not part of this slice.',
    );

    const timestamps = swaps
      .map((s) => num(s.timestamp))
      .filter((t): t is number => t !== null);
    const gaps = interArrivalGaps(timestamps);
    const senders = swaps.map((s) => (s.from ?? '').toLowerCase()).filter((s) => s !== '');
    const amounts = swaps
      .map((s) => num(s.amountInUSD))
      .filter((a): a is number => a !== null && a > 0);

    const selfTrades = swaps.filter(
      (s) => (s.from ?? '').toLowerCase() !== '' && (s.from ?? '').toLowerCase() === (s.to ?? '').toLowerCase(),
    ).length;

    const perSender = sumByKey(
      swaps
        .filter((s) => (s.from ?? '') !== '')
        .map((s) => ({ key: s.from!.toLowerCase(), value: num(s.amountInUSD) ?? 0 })),
    );

    const poolIds = swaps.map((s) => s.pool?.id ?? '').filter((p) => p !== '');

    const signals: SliceSignal[] = [
      signal('swap_count', swaps.length, 'count', 'swaps examined'),
      signal(
        'self_trade_share',
        swaps.length > 0 ? selfTrades / swaps.length : null,
        'share',
        'swaps where the sender and the recipient are the same address; a few are routers, a ' +
          'large fraction is one wallet trading with itself',
      ),
      signal(
        'interarrival_cv',
        coefficientOfVariation(gaps),
        'ratio',
        'coefficient of variation of the gaps between swaps; near 0 is a timer, near or above ' +
          '1 is bursty human demand',
      ),
      signal(
        'median_gap_seconds',
        median(gaps),
        'seconds',
        'median time between consecutive swaps',
      ),
      signal(
        'hour_concentration',
        hourConcentration(timestamps),
        'ratio',
        'how unevenly swaps fall across the 24 hours; 0 is perfectly spread, 1 is a single hour',
      ),
      signal(
        'unique_senders',
        uniqueCount(senders),
        'count',
        'distinct addresses that sent a swap',
      ),
      signal(
        'swaps_per_sender',
        ratio(swaps.length, uniqueCount(senders)),
        'ratio',
        'average swaps per address',
      ),
      signal(
        'top10_sender_volume_share',
        topNShare([...perSender.values()], 10),
        'share',
        'fraction of swap value from the ten busiest addresses',
      ),
      signal(
        'one_shot_sender_share',
        oneShotShare(senders),
        'share',
        'fraction of senders that swapped exactly once',
      ),
      signal(
        'round_amount_share',
        roundNumberShare(amounts),
        'share',
        'fraction of swap sizes that land on a round number; weak on its own, telling in ' +
          'combination with a low timing CV',
      ),
      signal(
        'pool_concentration',
        topNShare(
          [...sumByKey(poolIds.map((p) => ({ key: p, value: 1 }))).values()],
          1,
        ),
        'share',
        'fraction of swaps that happened in a single pool',
      ),
      signal(
        'tx_per_active_user',
        ratio(
          sum(usage.map((u) => num(u.dailyTransactionCount))),
          sum(usage.map((u) => num(u.dailyActiveUsers))),
        ),
        'ratio',
        'transactions per active user across the snapshot span',
      ),
      signal(
        'mean_swap_size',
        mean(amounts),
        'usd',
        'average swap size inside the window',
      ),
    ];

    return {
      sliceId: activitySlice.id,
      summary: buildSummary(
        `Transaction shape over the last ${ctx.windowDays ?? 30} days.`,
        [
          `${swaps.length} swaps from ${uniqueCount(senders)} distinct senders.`,
          `${selfTrades} of those swaps had the same address on both sides.`,
        ],
        signals,
        caveats,
      ),
      signals,
      raw: { swaps, usage },
      queryCostUsd: result.cost.usd ?? 0,
      sources: [ctx.subgraphId],
      queryCount: 1,
      caveats,
    };
  },
};
