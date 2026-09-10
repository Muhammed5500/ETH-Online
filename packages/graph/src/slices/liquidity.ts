/**
 * Liquidity slice — where the money sits and how hard it is working.
 *
 * The question this slice is built to inform: is the TVL a real float, or is
 * it a small amount of capital being cycled to produce a large number?
 *
 * Turnover is the sharp instrument. A pool doing many times its own depth in
 * daily volume is either the busiest venue on the chain or the same dollars
 * going round in a circle, and the honest reading depends on which pools and
 * how many. Concentration is what separates the two: real turnover is spread,
 * manufactured turnover collects in one place.
 *
 * Every field below is from the Messari `schema-dex-amm.graphql` standard, so
 * the same query runs against any protocol that implements it. That is the
 * leverage the standard buys, and the comparative slice spends it.
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
import { herfindahl, mean, median, ratio, sum, topNShare } from './stats.js';

const POOL_LIMIT = 100;

export const LIQUIDITY_QUERY = `
query LiquidityDepth($first: Int!, $since: BigInt!) {
  liquidityPools(
    first: $first
    orderBy: totalValueLockedUSD
    orderDirection: desc
    where: { totalValueLockedUSD_gt: "0" }
  ) {
    id
    name
    isSingleSided
    createdTimestamp
    totalValueLockedUSD
    cumulativeVolumeUSD
    inputTokenWeights
    dailySnapshots(first: 7, orderBy: timestamp, orderDirection: desc, where: { timestamp_gte: $since }) {
      timestamp
      dailyVolumeUSD
      totalValueLockedUSD
    }
  }
}`;

interface PoolRow {
  id?: string;
  name?: string | null;
  isSingleSided?: boolean;
  createdTimestamp?: string;
  totalValueLockedUSD?: string;
  cumulativeVolumeUSD?: string;
  inputTokenWeights?: string[];
  dailySnapshots?: Array<{
    timestamp?: string;
    dailyVolumeUSD?: string;
    totalValueLockedUSD?: string;
  }>;
}

export const liquiditySlice: DataSlice = {
  id: 'liquidity',
  name: 'Liquidity analyst',
  description:
    'Pool depth, how concentrated the TVL is, and how many times a day each pool turns over.',
  schema: 'dex-amm',

  async fetch(gateway: GraphGateway, ctx: QuestionContext): Promise<SliceEvidence> {
    const since = windowStart(ctx);
    const result = await gateway.query<{ liquidityPools?: PoolRow[] }>(
      ctx.subgraphId,
      LIQUIDITY_QUERY,
      { first: POOL_LIMIT, since: String(since) },
    );

    const pools = result.data.liquidityPools ?? [];
    const caveats: string[] = [];
    if (pools.length === 0) caveats.push('No pools with non-zero TVL were returned.');
    if (pools.length === POOL_LIMIT) {
      caveats.push(
        `Hit the ${POOL_LIMIT}-pool page limit, so concentration figures cover the largest ` +
          `${POOL_LIMIT} pools rather than every pool.`,
      );
    }

    const tvls = pools.map((p) => num(p.totalValueLockedUSD) ?? 0);
    const totalTvl = sum(tvls);

    // Recent volume, from the daily snapshots inside the window. Cumulative
    // volume is not usable for this: it covers the protocol's whole life, so a
    // protocol that was busy last year and is dead now would look identical to
    // one that is busy today.
    const dailyVolumes: number[] = [];
    const perPoolTurnover: number[] = [];
    for (const p of pools) {
      const snaps = p.dailySnapshots ?? [];
      const vols = snaps.map((s) => num(s.dailyVolumeUSD) ?? 0);
      const poolVolume = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
      if (poolVolume !== null) dailyVolumes.push(poolVolume);
      const tvl = num(p.totalValueLockedUSD);
      const t = ratio(poolVolume, tvl);
      if (t !== null) perPoolTurnover.push(t);
    }

    const withSnapshots = pools.filter((p) => (p.dailySnapshots ?? []).length > 0).length;
    if (pools.length > 0 && withSnapshots === 0) {
      caveats.push(
        'No daily snapshots fell inside the window, so turnover could not be computed. The ' +
          'subgraph may lag, or the protocol may have had no activity.',
      );
    }

    const freshCutoff = since;
    const freshTvl = sum(
      pools
        .filter((p) => (num(p.createdTimestamp) ?? 0) >= freshCutoff)
        .map((p) => num(p.totalValueLockedUSD) ?? 0),
    );

    const signals: SliceSignal[] = [
      signal('pool_count', pools.length, 'count', 'pools with non-zero TVL in the page fetched'),
      signal('total_tvl', totalTvl, 'usd', 'TVL across those pools'),
      signal(
        'top1_tvl_share',
        topNShare(tvls, 1),
        'share',
        'fraction of TVL in the single largest pool',
      ),
      signal(
        'top10_tvl_share',
        topNShare(tvls, 10),
        'share',
        'fraction of TVL in the ten largest pools',
      ),
      signal(
        'tvl_hhi',
        herfindahl(tvls),
        'ratio',
        'Herfindahl over pool TVL; 1 is one pool, 1/n is n equal pools',
      ),
      signal(
        'median_turnover',
        median(perPoolTurnover),
        'ratio',
        'median pool daily volume divided by its own TVL; above ~1 means the pool trades its ' +
          'entire depth every day',
      ),
      signal(
        'max_turnover',
        perPoolTurnover.length > 0 ? Math.max(...perPoolTurnover) : null,
        'ratio',
        'the most heavily cycled pool, same measure',
      ),
      signal(
        'mean_daily_volume',
        mean(dailyVolumes),
        'usd',
        'average per-pool daily volume inside the window',
      ),
      signal(
        'fresh_tvl_share',
        ratio(freshTvl, totalTvl),
        'share',
        'fraction of TVL sitting in pools created inside the window',
      ),
      signal(
        'single_sided_share',
        pools.length > 0 ? pools.filter((p) => p.isSingleSided === true).length / pools.length : null,
        'share',
        'fraction of pools that are single-sided',
      ),
    ];

    const named = pools
      .slice(0, 5)
      .map(
        (p, i) =>
          `  ${i + 1}. ${p.name ?? p.id ?? 'unnamed'} — $${(num(p.totalValueLockedUSD) ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
      );

    return {
      sliceId: liquiditySlice.id,
      summary: buildSummary(
        `Liquidity depth over the last ${ctx.windowDays ?? 30} days.`,
        ['Largest pools by TVL:', ...named],
        signals,
        caveats,
      ),
      signals,
      raw: pools,
      queryCostUsd: result.cost.usd ?? 0,
      sources: [ctx.subgraphId],
      queryCount: 1,
      caveats,
    };
  },
};
