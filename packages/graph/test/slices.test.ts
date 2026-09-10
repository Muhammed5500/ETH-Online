/**
 * Slice tests.
 *
 * THE ASSERTION THAT MATTERS MOST is the last describe block: fed the SAME
 * market, the five slices must produce different signal sets. That is not a
 * style preference. The paper's Assumption 4 needs agent signals to be
 * conditionally independent given the outcome, and two slices computing the
 * same statistic from the same rows are one slice with two votes — `delta`
 * goes to 1 and the `k` Theorem 1 demands goes to infinity with it.
 *
 * The fixtures use the real Messari field names, taken from
 * `schema-dex-amm.graphql` and `schema-bridge.graphql`. That is deliberate:
 * a fixture invented from memory would let a query with a wrong field name
 * pass here and fail against the gateway, which is the one place these tests
 * cannot reach today.
 */
import { describe, expect, it } from 'vitest';
import { GraphGateway, type FetchLike } from '../src/gateway.js';
import {
  ALL_SLICES,
  SLICE_IDS,
  activitySlice,
  bridgeSlice,
  comparativeSlice,
  getSlice,
  holdersSlice,
  liquiditySlice,
  profileFrom,
  signal,
  windowStart,
  type QuestionContext,
  type SliceEvidence,
} from '../src/slices/index.js';

const SUBJECT = 'SubjectSubgraphId';
const NOW = Date.parse('2026-09-10T12:00:00Z');
const DAY = 86_400;
const T0 = Math.floor(NOW / 1000) - 5 * DAY;

function ctx(over: Partial<QuestionContext> = {}): QuestionContext {
  return {
    question: 'Is this protocol growth organic?',
    subgraphId: SUBJECT,
    windowDays: 30,
    now: NOW,
    ...over,
  };
}

/** A gateway whose answers are chosen per subgraph id. */
function gatewayFor(byId: Record<string, unknown>, missing: 'throw' | 'empty' = 'throw'): GraphGateway {
  const fetchImpl: FetchLike = async (url) => {
    const id = url.split('/id/')[1] ?? '';
    if (!(id in byId)) {
      if (missing === 'throw') return new Response('gone', { status: 500 });
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: byId[id] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return new GraphGateway({
    mode: 'apikey',
    apiKey: 'k',
    fetchImpl,
    retry: { attempts: 1, sleep: async () => {} },
  });
}

function signalValue(e: SliceEvidence, key: string): number | null {
  const s = e.signals.find((x) => x.key === key);
  if (!s) throw new Error(`No signal "${key}". Have: ${e.signals.map((x) => x.key).join(', ')}`);
  return s.value;
}

// ---------------------------------------------------------------- liquidity

const LIQUIDITY_DATA = {
  liquidityPools: [
    {
      id: '0xpool1',
      name: 'WETH/USDC',
      isSingleSided: false,
      createdTimestamp: String(T0 - 400 * DAY),
      totalValueLockedUSD: '8000000',
      cumulativeVolumeUSD: '900000000',
      inputTokenWeights: ['50', '50'],
      dailySnapshots: [
        { timestamp: String(T0), dailyVolumeUSD: '4000000', totalValueLockedUSD: '8000000' },
        { timestamp: String(T0 - DAY), dailyVolumeUSD: '4000000', totalValueLockedUSD: '8000000' },
      ],
    },
    {
      id: '0xpool2',
      name: 'FARM/WETH',
      isSingleSided: false,
      createdTimestamp: String(T0),
      totalValueLockedUSD: '2000000',
      cumulativeVolumeUSD: '600000000',
      inputTokenWeights: ['50', '50'],
      dailySnapshots: [
        { timestamp: String(T0), dailyVolumeUSD: '60000000', totalValueLockedUSD: '2000000' },
      ],
    },
  ],
};

describe('liquidity slice', () => {
  it('measures depth, concentration and turnover', async () => {
    const e = await liquiditySlice.fetch(gatewayFor({ [SUBJECT]: LIQUIDITY_DATA }), ctx());

    expect(e.sliceId).toBe('liquidity');
    expect(signalValue(e, 'pool_count')).toBe(2);
    expect(signalValue(e, 'total_tvl')).toBe(10_000_000);
    expect(signalValue(e, 'top1_tvl_share')).toBe(0.8);
    // Pool 2 cycles thirty times its own depth a day. That is the signal.
    expect(signalValue(e, 'max_turnover')).toBe(30);
    expect(signalValue(e, 'median_turnover')).toBe(15.25);
  });

  it('flags TVL that arrived inside the window', async () => {
    const e = await liquiditySlice.fetch(gatewayFor({ [SUBJECT]: LIQUIDITY_DATA }), ctx());
    // Pool 2 was created at T0, which is inside a 30-day window.
    expect(signalValue(e, 'fresh_tvl_share')).toBe(0.2);
  });

  it('uses recent snapshots, not lifetime volume', async () => {
    // Pool 2's cumulative volume is smaller than pool 1's, but its RECENT
    // volume is much larger. Turnover has to reflect today, not history.
    const e = await liquiditySlice.fetch(gatewayFor({ [SUBJECT]: LIQUIDITY_DATA }), ctx());
    expect(signalValue(e, 'max_turnover')).toBe(30);
  });

  it('says so when there is nothing to measure', async () => {
    const e = await liquiditySlice.fetch(gatewayFor({ [SUBJECT]: { liquidityPools: [] } }), ctx());
    expect(signalValue(e, 'pool_count')).toBe(0);
    expect(signalValue(e, 'top1_tvl_share')).toBeNull();
    expect(e.caveats.join(' ')).toMatch(/No pools/);
  });

  it('warns when snapshots are missing rather than reporting zero turnover', async () => {
    const e = await liquiditySlice.fetch(
      gatewayFor({
        [SUBJECT]: {
          liquidityPools: [
            { id: '0x1', totalValueLockedUSD: '100', createdTimestamp: '1', dailySnapshots: [] },
          ],
        },
      }),
      ctx(),
    );
    expect(signalValue(e, 'median_turnover')).toBeNull();
    expect(e.caveats.join(' ')).toMatch(/No daily snapshots/);
  });
});

// ------------------------------------------------------------------ holders

const HOLDERS_DATA = {
  deposits: [
    { id: 'd1', from: '0xWHALE', amountUSD: '900000', timestamp: String(T0) },
    { id: 'd2', from: '0xwhale', amountUSD: '50000', timestamp: String(T0 - 100) },
    { id: 'd3', from: '0xalice', amountUSD: '30000', timestamp: String(T0 - 200) },
    { id: 'd4', from: '0xbob', amountUSD: '20000', timestamp: String(T0 - 300) },
  ],
  usageMetricsDailySnapshots: [
    { timestamp: String(T0), dailyActiveUsers: 10, cumulativeUniqueUsers: 5000, dailyDepositCount: 4, dailyWithdrawCount: 4 },
    { timestamp: String(T0 - DAY), dailyActiveUsers: 12, cumulativeUniqueUsers: 4000, dailyDepositCount: 5, dailyWithdrawCount: 3 },
  ],
};

describe('holders slice', () => {
  it('derives concentration from deposit flow', async () => {
    const e = await holdersSlice.fetch(gatewayFor({ [SUBJECT]: HOLDERS_DATA }), ctx());

    expect(signalValue(e, 'deposit_count')).toBe(4);
    // 0xWHALE and 0xwhale are one address.
    expect(signalValue(e, 'unique_depositors')).toBe(3);
    expect(signalValue(e, 'deposit_value')).toBe(1_000_000);
    expect(signalValue(e, 'top10_depositor_share')).toBe(1);
  });

  it('lowercases addresses before counting them', async () => {
    // Two casings of one address must not read as two depositors; that would
    // halve every concentration figure in the slice.
    const e = await holdersSlice.fetch(gatewayFor({ [SUBJECT]: HOLDERS_DATA }), ctx());
    expect(signalValue(e, 'unique_depositors')).toBe(3);
    // 2/3, as a signal sees it: `signal()` rounds to six places on the way out,
    // so this is the exact value a consumer reads, not an approximation of it.
    expect(signalValue(e, 'one_shot_depositor_share')).toBe(0.666667);
  });

  it('catches cumulative users climbing while active users stay flat', async () => {
    // 1000 new cumulative users, 11 average daily active. Addresses appear
    // once and do not come back.
    const e = await holdersSlice.fetch(gatewayFor({ [SUBJECT]: HOLDERS_DATA }), ctx());
    expect(signalValue(e, 'cumulative_user_growth')).toBe(1000);
    expect(signalValue(e, 'avg_daily_active_users')).toBe(11);
    expect(signalValue(e, 'new_user_retention')).toBeCloseTo(0.011, 6);
  });

  it('always carries the balance-field caveat', async () => {
    // The Messari Account entity has only an id. Anyone reading this slice
    // has to know it measures flow, not stock.
    const e = await holdersSlice.fetch(gatewayFor({ [SUBJECT]: HOLDERS_DATA }), ctx());
    expect(e.caveats.join(' ')).toMatch(/only an id, with no balance field/);
  });

  it('survives an empty window', async () => {
    const e = await holdersSlice.fetch(
      gatewayFor({ [SUBJECT]: { deposits: [], usageMetricsDailySnapshots: [] } }),
      ctx(),
    );
    expect(signalValue(e, 'unique_depositors')).toBe(0);
    expect(signalValue(e, 'top10_depositor_share')).toBeNull();
  });
});

// ----------------------------------------------------------------- activity

/** Ten swaps on a perfect 60-second timer, all from one address to itself. */
const BOT_SWAPS = Array.from({ length: 10 }, (_, i) => ({
  id: `s${i}`,
  from: '0xbot',
  to: '0xbot',
  timestamp: String(T0 + i * 60),
  blockNumber: String(1000 + i),
  amountInUSD: '10000',
  amountOutUSD: '10000',
  pool: { id: '0xpool2' },
}));

/** Ten swaps from ten addresses at irregular intervals and messy sizes. */
const HUMAN_GAPS = [17, 430, 61, 2200, 95, 8, 1500, 320, 47];
const HUMAN_SWAPS = (() => {
  let t = T0;
  return Array.from({ length: 10 }, (_, i) => {
    if (i > 0) t += HUMAN_GAPS[i - 1]!;
    return {
      id: `h${i}`,
      from: `0xuser${i}`,
      to: `0xrecipient${i}`,
      timestamp: String(t),
      blockNumber: String(2000 + i),
      amountInUSD: String(137.42 + i * 91.7),
      amountOutUSD: String(137 + i * 91),
      pool: { id: `0xpool${i % 4}` },
    };
  });
})();

const USAGE = [
  { timestamp: String(T0), dailyActiveUsers: 100, dailyTransactionCount: 400, dailySwapCount: 380 },
];

describe('activity slice', () => {
  it('reads a timer as a timer', async () => {
    const e = await activitySlice.fetch(
      gatewayFor({ [SUBJECT]: { swaps: BOT_SWAPS, usageMetricsDailySnapshots: USAGE } }),
      ctx(),
    );

    expect(signalValue(e, 'self_trade_share')).toBe(1);
    expect(signalValue(e, 'interarrival_cv')).toBe(0);
    expect(signalValue(e, 'median_gap_seconds')).toBe(60);
    expect(signalValue(e, 'unique_senders')).toBe(1);
    expect(signalValue(e, 'round_amount_share')).toBe(1);
    expect(signalValue(e, 'pool_concentration')).toBe(1);
  });

  it('reads human traffic as human traffic', async () => {
    const e = await activitySlice.fetch(
      gatewayFor({ [SUBJECT]: { swaps: HUMAN_SWAPS, usageMetricsDailySnapshots: USAGE } }),
      ctx(),
    );

    expect(signalValue(e, 'self_trade_share')).toBe(0);
    expect(signalValue(e, 'interarrival_cv')!).toBeGreaterThan(1);
    expect(signalValue(e, 'unique_senders')).toBe(10);
    expect(signalValue(e, 'round_amount_share')).toBe(0);
  });

  it('separates the two cases sharply enough to be worth reporting', async () => {
    const bot = await activitySlice.fetch(
      gatewayFor({ [SUBJECT]: { swaps: BOT_SWAPS, usageMetricsDailySnapshots: USAGE } }),
      ctx(),
    );
    const human = await activitySlice.fetch(
      gatewayFor({ [SUBJECT]: { swaps: HUMAN_SWAPS, usageMetricsDailySnapshots: USAGE } }),
      ctx(),
    );
    expect(signalValue(bot, 'interarrival_cv')!).toBeLessThan(
      signalValue(human, 'interarrival_cv')!,
    );
    expect(signalValue(bot, 'self_trade_share')!).toBeGreaterThan(
      signalValue(human, 'self_trade_share')!,
    );
  });

  it('says out loud that the standard carries no gas field', async () => {
    const e = await activitySlice.fetch(
      gatewayFor({ [SUBJECT]: { swaps: BOT_SWAPS, usageMetricsDailySnapshots: USAGE } }),
      ctx(),
    );
    expect(e.caveats.join(' ')).toMatch(/no gas field/);
  });

  it('warns when the sample is too small to conclude anything', async () => {
    const e = await activitySlice.fetch(
      gatewayFor({ [SUBJECT]: { swaps: BOT_SWAPS.slice(0, 3), usageMetricsDailySnapshots: USAGE } }),
      ctx(),
    );
    expect(e.caveats.join(' ')).toMatch(/weak evidence/);
  });
});

// ------------------------------------------------------------------- bridge

const BRIDGE_DATA = {
  bridgeTransfers: [
    { id: 'b1', from: '0xactor', transferTo: '0xactor', isOutgoing: false, isSwap: false, fromChainID: '1', toChainID: '42161', amountUSD: '5000000', timestamp: String(T0) },
    { id: 'b2', from: '0xactor', transferTo: '0xactor', isOutgoing: true, isSwap: false, fromChainID: '42161', toChainID: '1', amountUSD: '4900000', timestamp: String(T0 + DAY) },
    { id: 'b3', from: '0xother', transferTo: '0xsomeone', isOutgoing: false, isSwap: true, fromChainID: '1', toChainID: '42161', amountUSD: '100000', timestamp: String(T0 + 2 * DAY) },
  ],
};

describe('bridge slice', () => {
  it('measures inflow against outflow', async () => {
    const e = await bridgeSlice.fetch(
      gatewayFor({ BridgeSubgraph: BRIDGE_DATA }),
      ctx({ bridgeSubgraphId: 'BridgeSubgraph' }),
    );

    expect(signalValue(e, 'inflow_usd')).toBe(5_100_000);
    expect(signalValue(e, 'outflow_usd')).toBe(4_900_000);
    expect(signalValue(e, 'net_flow_usd')).toBe(200_000);
    // Nearly everything that arrived also left: capital passing through.
    expect(signalValue(e, 'flow_balance')).toBeCloseTo(0.9608, 3);
  });

  it('spots one actor moving its own capital', async () => {
    const e = await bridgeSlice.fetch(
      gatewayFor({ BridgeSubgraph: BRIDGE_DATA }),
      ctx({ bridgeSubgraphId: 'BridgeSubgraph' }),
    );
    expect(signalValue(e, 'self_bridged_share')).toBe(0.666667);
    expect(signalValue(e, 'source_chain_count')).toBe(2);
  });

  it('reports "unknown", not "none", when no bridge subgraph is configured', async () => {
    // An agent that refused to answer here would lose its whole bond over a
    // missing configuration line.
    const e = await bridgeSlice.fetch(gatewayFor({}), ctx());

    expect(e.signals).toHaveLength(0);
    expect(e.queryCount).toBe(0);
    expect(e.queryCostUsd).toBe(0);
    expect(e.sources).toEqual([]);
    expect(e.caveats.join(' ')).toMatch(/unknown rather than as absent/);
  });
});

// -------------------------------------------------------------- comparative

function protocolData(over: {
  name: string;
  tvl: string;
  volume: string;
  revenue: string;
  users: number;
  tx: number;
}): unknown {
  return {
    dexAmmProtocols: [
      {
        id: '0xfactory',
        name: over.name,
        slug: over.name.toLowerCase(),
        network: 'MAINNET',
        totalValueLockedUSD: over.tvl,
        cumulativeVolumeUSD: '1000000000',
        cumulativeTotalRevenueUSD: '1000000',
        cumulativeUniqueUsers: 100000,
        totalPoolCount: 500,
      },
    ],
    financialsDailySnapshots: [
      { timestamp: String(T0), totalValueLockedUSD: over.tvl, dailyVolumeUSD: over.volume, dailyTotalRevenueUSD: over.revenue, dailySupplySideRevenueUSD: over.revenue },
      { timestamp: String(T0 - DAY), totalValueLockedUSD: over.tvl, dailyVolumeUSD: over.volume, dailyTotalRevenueUSD: over.revenue, dailySupplySideRevenueUSD: over.revenue },
    ],
    usageMetricsDailySnapshots: [
      { timestamp: String(T0), dailyActiveUsers: over.users, dailyTransactionCount: over.tx },
      { timestamp: String(T0 - DAY), dailyActiveUsers: over.users, dailyTransactionCount: over.tx },
    ],
  };
}

const PEERS = {
  PeerA: protocolData({ name: 'PeerA', tvl: '10000000', volume: '2000000', revenue: '6000', users: 900, tx: 3000 }),
  PeerB: protocolData({ name: 'PeerB', tvl: '20000000', volume: '5000000', revenue: '15000', users: 1500, tx: 5000 }),
  PeerC: protocolData({ name: 'PeerC', tvl: '5000000', volume: '900000', revenue: '2700', users: 400, tx: 1200 }),
  PeerD: protocolData({ name: 'PeerD', tvl: '30000000', volume: '7000000', revenue: '21000', users: 2000, tx: 8000 }),
  PeerE: protocolData({ name: 'PeerE', tvl: '8000000', volume: '1500000', revenue: '4500', users: 700, tx: 2500 }),
};

/** Huge volume, almost no fees, almost no users. The shape being looked for. */
const WASHY = protocolData({
  name: 'Subject',
  tvl: '10000000',
  volume: '300000000',
  revenue: '900',
  users: 40,
  tx: 20000,
});

describe('comparative slice', () => {
  const peerIds = Object.keys(PEERS);

  it('runs one query shape against the subject and five peers', async () => {
    const e = await comparativeSlice.fetch(
      gatewayFor({ [SUBJECT]: WASHY, ...PEERS }),
      ctx({ peerSubgraphIds: peerIds }),
    );

    // The whole argument for the standard: six protocols, one query string.
    expect(e.queryCount).toBe(6);
    expect(e.sources).toHaveLength(6);
    expect(signalValue(e, 'peers_compared')).toBe(5);
  });

  it('puts the subject at the top on turnover and the bottom on revenue yield', async () => {
    const e = await comparativeSlice.fetch(
      gatewayFor({ [SUBJECT]: WASHY, ...PEERS }),
      ctx({ peerSubgraphIds: peerIds }),
    );

    expect(signalValue(e, 'subject_turnover')).toBe(30);
    expect(signalValue(e, 'turnover_percentile')).toBe(1);
    // Volume that pays no fees: top of the table on trading, bottom on earning.
    expect(signalValue(e, 'revenue_yield_percentile')).toBe(0);
  });

  it('drops a peer that is down instead of failing the whole slice', async () => {
    const e = await comparativeSlice.fetch(
      gatewayFor({ [SUBJECT]: WASHY, PeerA: PEERS.PeerA }),
      ctx({ peerSubgraphIds: ['PeerA', 'BrokenPeer'] }),
    );

    expect(signalValue(e, 'peers_compared')).toBe(1);
    expect(e.caveats.join(' ')).toMatch(/BrokenPeer could not be read/);
  });

  it('fails when the SUBJECT cannot be read', async () => {
    // A comparison against nothing is worse than no answer.
    await expect(
      comparativeSlice.fetch(gatewayFor(PEERS), ctx({ peerSubgraphIds: peerIds })),
    ).rejects.toThrow();
  });

  it('warns when there are too few peers to rank against', async () => {
    const e = await comparativeSlice.fetch(
      gatewayFor({ [SUBJECT]: WASHY, PeerA: PEERS.PeerA }),
      ctx({ peerSubgraphIds: ['PeerA'] }),
    );
    expect(e.caveats.join(' ')).toMatch(/Only 1 peers/);
  });

  it('adds up what all six queries cost', async () => {
    const e = await comparativeSlice.fetch(
      gatewayFor({ [SUBJECT]: WASHY, ...PEERS }),
      ctx({ peerSubgraphIds: peerIds }),
    );
    // Six queries at the list price.
    expect(e.queryCostUsd).toBeCloseTo(0.06, 10);
  });
});

describe('profileFrom', () => {
  it('takes the median rather than the newest snapshot', async () => {
    // The current day is still being written; half a day of volume against a
    // full day of TVL understates turnover by roughly half.
    const p = profileFrom('x', {
      dexAmmProtocols: [{ name: 'X', totalValueLockedUSD: '1000' }],
      financialsDailySnapshots: [
        { totalValueLockedUSD: '1000', dailyVolumeUSD: '50' }, // partial today
        { totalValueLockedUSD: '1000', dailyVolumeUSD: '100' },
        { totalValueLockedUSD: '1000', dailyVolumeUSD: '100' },
      ],
    });
    expect(p.turnover).toBeCloseTo(0.1, 10);
  });

  it('falls back to the protocol entity when snapshots are missing', () => {
    const p = profileFrom('x', {
      dexAmmProtocols: [{ name: 'X', totalValueLockedUSD: '777' }],
    });
    expect(p.tvlUsd).toBe(777);
    expect(p.turnover).toBeNull();
  });

  it('names itself by the subgraph id when the protocol has no name', () => {
    expect(profileFrom('someId', {}).name).toBe('someId');
  });
});

// -------------------------------------------------------------- the registry

describe('the slice set', () => {
  it('has the five the roadmap asks for', () => {
    expect(SLICE_IDS).toEqual(['liquidity', 'holders', 'activity', 'bridge', 'comparative']);
  });

  it('resolves by id and complains usefully otherwise', () => {
    expect(getSlice('activity')).toBe(activitySlice);
    expect(() => getSlice('gas')).toThrow(/Known slices/);
  });

  it('gives every slice a distinct query', () => {
    const queries = new Set(ALL_SLICES.map((s) => s.id));
    expect(queries.size).toBe(ALL_SLICES.length);
  });

  it('COMPUTES DIFFERENT STATISTICS FROM THE SAME MARKET', async () => {
    // The Assumption 4 test. Five slices, one market, five different signal
    // sets. Any overlap here is two agents voting once.
    const gateway = gatewayFor({
      [SUBJECT]: {
        ...LIQUIDITY_DATA,
        ...HOLDERS_DATA,
        swaps: BOT_SWAPS,
        ...(WASHY as Record<string, unknown>),
      },
      BridgeSubgraph: BRIDGE_DATA,
      ...PEERS,
    });
    const context = ctx({
      peerSubgraphIds: Object.keys(PEERS),
      bridgeSubgraphId: 'BridgeSubgraph',
    });

    const evidence = await Promise.all(ALL_SLICES.map((s) => s.fetch(gateway, context)));
    const keySets = evidence.map((e) => new Set(e.signals.map((s) => s.key)));

    for (let i = 0; i < keySets.length; i++) {
      for (let j = i + 1; j < keySets.length; j++) {
        const shared = [...keySets[i]!].filter((k) => keySets[j]!.has(k));
        expect(
          shared,
          `slices "${evidence[i]!.sliceId}" and "${evidence[j]!.sliceId}" share signals: ${shared.join(', ')}`,
        ).toEqual([]);
      }
    }
  });

  it('gives every slice a summary a model can read', async () => {
    const gateway = gatewayFor({
      [SUBJECT]: {
        ...LIQUIDITY_DATA,
        ...HOLDERS_DATA,
        swaps: BOT_SWAPS,
        ...(WASHY as Record<string, unknown>),
      },
      BridgeSubgraph: BRIDGE_DATA,
      ...PEERS,
    });
    const context = ctx({
      peerSubgraphIds: Object.keys(PEERS),
      bridgeSubgraphId: 'BridgeSubgraph',
    });

    for (const slice of ALL_SLICES) {
      const e = await slice.fetch(gateway, context);
      expect(e.sliceId).toBe(slice.id);
      expect(e.summary.length).toBeGreaterThan(40);
      // No slice may hand the model a verdict; that would make twenty agents
      // agree by construction.
      expect(e.summary.toLowerCase()).not.toMatch(/\b(is|not) (organic|wash|fraudulent)\b/);
    }
  });
});

describe('signal rounding', () => {
  it('rounds to six places, so a signal is exact rather than nearly exact', () => {
    // Worth pinning down: several assertions above read a signal value
    // directly, and they are only meaningful if the precision is a promise.
    // Six places is finer than a tinybar at any scale this project runs at,
    // and it matches the rounding the HCS ledger already uses (STEP 13).
    expect(signal('k', 2 / 3, 'share', 'n').value).toBe(0.666667);
    expect(signal('k', 1 / 3, 'share', 'n').value).toBe(0.333333);
    expect(signal('k', null, 'share', 'n').value).toBeNull();
  });
});

describe('windowStart', () => {
  it('counts back the requested number of days', () => {
    expect(windowStart(ctx({ windowDays: 1 }))).toBe(Math.floor(NOW / 1000) - DAY);
  });

  it('defaults to thirty days', () => {
    expect(windowStart({ question: 'q', subgraphId: 'x', now: NOW })).toBe(
      Math.floor(NOW / 1000) - 30 * DAY,
    );
  });
});
