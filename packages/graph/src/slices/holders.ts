/**
 * Holders slice — who is actually putting money in, and how many of them there are.
 *
 * A SCHEMA LIMIT THAT SHAPED THIS SLICE. The Messari standard's `Account`
 * entity has exactly one field: `id`. There is no balance, no position, no
 * holding period. Anyone writing a "holder concentration" query from memory
 * will reach for a balance field that does not exist, and the gateway will
 * answer HTTP 200 with a GraphQL error saying so — which, without the checks
 * in the gateway client, would reach an agent as an empty evidence set.
 *
 * So concentration is derived from FLOW rather than read from stock: the
 * `Deposit` events inside the window carry `from` and `amountUSD`, and summing
 * them per address gives who supplied what. It is a different quantity from a
 * balance snapshot — it misses capital deposited before the window — and that
 * limitation is reported as a caveat rather than papered over.
 *
 * The pairing that carries the most information here is `cumulativeUniqueUsers`
 * against `dailyActiveUsers`. Cumulative users only ever goes up, so growth in
 * it proves nothing on its own. When cumulative climbs steeply while daily
 * active stays flat, addresses are being created and not returning — which is
 * what farmed growth looks like from the outside.
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
import { herfindahl, mean, oneShotShare, ratio, sum, sumByKey, topNShare, uniqueCount } from './stats.js';

const DEPOSIT_LIMIT = 1000;
const SNAPSHOT_LIMIT = 30;

export const HOLDERS_QUERY = `
query DepositorBase($first: Int!, $snapshots: Int!, $since: BigInt!) {
  deposits(
    first: $first
    orderBy: timestamp
    orderDirection: desc
    where: { timestamp_gte: $since }
  ) {
    id
    from
    amountUSD
    timestamp
  }
  usageMetricsDailySnapshots(first: $snapshots, orderBy: timestamp, orderDirection: desc) {
    timestamp
    dailyActiveUsers
    cumulativeUniqueUsers
    dailyDepositCount
    dailyWithdrawCount
  }
}`;

interface DepositRow {
  id?: string;
  from?: string;
  amountUSD?: string;
  timestamp?: string;
}

interface UsageRow {
  timestamp?: string;
  dailyActiveUsers?: number;
  cumulativeUniqueUsers?: number;
  dailyDepositCount?: number;
  dailyWithdrawCount?: number;
}

export const holdersSlice: DataSlice = {
  id: 'holders',
  name: 'Holder analyst',
  description:
    'Who supplied the capital, how concentrated they are, and whether new addresses come back.',
  schema: 'dex-amm',

  async fetch(gateway: GraphGateway, ctx: QuestionContext): Promise<SliceEvidence> {
    const since = windowStart(ctx);
    const result = await gateway.query<{
      deposits?: DepositRow[];
      usageMetricsDailySnapshots?: UsageRow[];
    }>(ctx.subgraphId, HOLDERS_QUERY, {
      first: DEPOSIT_LIMIT,
      snapshots: SNAPSHOT_LIMIT,
      since: String(since),
    });

    const deposits = result.data.deposits ?? [];
    const usage = result.data.usageMetricsDailySnapshots ?? [];
    const caveats: string[] = [
      'Concentration here is measured over deposits made inside the window, not over current ' +
        'balances: the Messari Account entity carries only an id, with no balance field. ' +
        'Capital deposited before the window is invisible to this slice.',
    ];

    if (deposits.length === DEPOSIT_LIMIT) {
      caveats.push(
        `Hit the ${DEPOSIT_LIMIT}-deposit page limit, so figures cover the most recent ` +
          `${DEPOSIT_LIMIT} deposits rather than the whole window.`,
      );
    }
    if (deposits.length === 0) caveats.push('No deposits fell inside the window.');
    if (usage.length === 0) caveats.push('No usage snapshots were returned.');

    const senders = deposits.map((d) => (d.from ?? '').toLowerCase()).filter((s) => s !== '');
    const perAddress = sumByKey(
      deposits
        .filter((d) => (d.from ?? '') !== '')
        .map((d) => ({ key: d.from!.toLowerCase(), value: num(d.amountUSD) ?? 0 })),
    );
    const amounts = [...perAddress.values()];

    // Newest snapshot first, so [0] is the most recent day.
    const newestUsage = usage[0];
    const oldestUsage = usage[usage.length - 1];
    const cumulativeGrowth =
      newestUsage && oldestUsage
        ? (num(newestUsage.cumulativeUniqueUsers) ?? 0) - (num(oldestUsage.cumulativeUniqueUsers) ?? 0)
        : null;
    const avgDailyActive = mean(usage.map((u) => num(u.dailyActiveUsers)));

    const signals: SliceSignal[] = [
      signal('deposit_count', deposits.length, 'count', 'deposits inside the window'),
      signal(
        'unique_depositors',
        uniqueCount(senders),
        'count',
        'distinct addresses that deposited inside the window',
      ),
      signal('deposit_value', sum(amounts), 'usd', 'total deposited inside the window'),
      signal(
        'top10_depositor_share',
        topNShare(amounts, 10),
        'share',
        'fraction of deposited value from the ten largest depositors',
      ),
      signal(
        'depositor_hhi',
        herfindahl(amounts),
        'ratio',
        'Herfindahl over depositor value; high means a handful of addresses supplied everything',
      ),
      signal(
        'one_shot_depositor_share',
        oneShotShare(senders),
        'share',
        'fraction of depositors that deposited exactly once in the window',
      ),
      signal(
        'avg_daily_active_users',
        avgDailyActive,
        'count',
        'mean daily active users across the snapshots returned',
      ),
      signal(
        'cumulative_user_growth',
        cumulativeGrowth,
        'count',
        'new cumulative unique users across the snapshot span',
      ),
      signal(
        'new_user_retention',
        ratio(avgDailyActive, cumulativeGrowth),
        'ratio',
        'daily active users against new users arriving; a low value means addresses appear ' +
          'once and do not come back',
      ),
      signal(
        'withdraw_to_deposit_ratio',
        ratio(
          sum(usage.map((u) => num(u.dailyWithdrawCount))),
          sum(usage.map((u) => num(u.dailyDepositCount))),
        ),
        'ratio',
        'withdrawals per deposit over the snapshot span; near 1 means capital arrives and ' +
          'leaves at the same rate',
      ),
    ];

    return {
      sliceId: holdersSlice.id,
      summary: buildSummary(
        `Depositor base over the last ${ctx.windowDays ?? 30} days.`,
        [
          `${deposits.length} deposits from ${uniqueCount(senders)} distinct addresses.`,
          usage.length > 0
            ? `Usage snapshots span ${usage.length} days, most recent cumulative unique users: ${newestUsage?.cumulativeUniqueUsers ?? 'unknown'}.`
            : 'No usage snapshots available.',
        ],
        signals,
        caveats,
      ),
      signals,
      raw: { deposits, usage },
      queryCostUsd: result.cost.usd ?? 0,
      sources: [ctx.subgraphId],
      queryCount: 1,
      caveats,
    };
  },
};
