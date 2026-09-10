/**
 * Bridge slice — where the capital came from and whether it stayed.
 *
 * The only slice that looks off the chain the question is about, which is
 * exactly why it belongs: its signal cannot be correlated with the others by
 * construction, and Assumption 4 asks for signals that are independent given
 * the outcome.
 *
 * What it is looking for: capital that arrives from one chain, sits long
 * enough to be counted in a TVL snapshot, and leaves. That pattern is
 * invisible to every slice that only reads the destination protocol, because
 * on that side it looks like a deposit and a withdrawal by unrelated
 * addresses.
 *
 * A DIFFERENT SCHEMA, NOT THE SAME ONE WITH DIFFERENT FIELDS. This reads
 * Messari's `schema-bridge.graphql`, where ids and addresses are `Bytes!`
 * rather than the `String!` of the DEX schema, and the event carries
 * `fromChainID`, `toChainID` and `isOutgoing`. Pointing this slice at a DEX
 * subgraph produces a GraphQL error, not an empty result — which the gateway
 * client turns into a thrown error rather than silent nothing.
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
import { herfindahl, ratio, sum, sumByKey, topNShare, uniqueCount } from './stats.js';

const TRANSFER_LIMIT = 1000;

export const BRIDGE_QUERY = `
query CrossChainFlow($first: Int!, $since: BigInt!) {
  bridgeTransfers(
    first: $first
    orderBy: timestamp
    orderDirection: desc
    where: { timestamp_gte: $since }
  ) {
    id
    from
    to
    transferTo
    isOutgoing
    isSwap
    fromChainID
    toChainID
    amountUSD
    timestamp
  }
}`;

interface TransferRow {
  id?: string;
  from?: string;
  to?: string;
  transferTo?: string;
  isOutgoing?: boolean;
  isSwap?: boolean;
  fromChainID?: string;
  toChainID?: string;
  amountUSD?: string;
  timestamp?: string;
}

export const bridgeSlice: DataSlice = {
  id: 'bridge',
  name: 'Bridge analyst',
  description:
    'Cross-chain inflow against outflow, how many chains it comes from, and how concentrated the routes are.',
  schema: 'bridge',

  async fetch(gateway: GraphGateway, ctx: QuestionContext): Promise<SliceEvidence> {
    const subgraphId = ctx.bridgeSubgraphId;
    if (!subgraphId) {
      // Not an error. A question about a protocol with no bridge exposure has
      // nothing for this slice to say, and an agent that refused to answer
      // would lose its whole bond over a missing configuration line.
      const caveats = [
        'No bridge subgraph was configured for this question, so no cross-chain evidence was ' +
          'gathered. Treat cross-chain flow as unknown rather than as absent.',
      ];
      return {
        sliceId: bridgeSlice.id,
        summary: buildSummary('Cross-chain flow: not available.', [], [], caveats),
        signals: [],
        raw: null,
        queryCostUsd: 0,
        sources: [],
        queryCount: 0,
        caveats,
      };
    }

    const since = windowStart(ctx);
    const result = await gateway.query<{ bridgeTransfers?: TransferRow[] }>(
      subgraphId,
      BRIDGE_QUERY,
      { first: TRANSFER_LIMIT, since: String(since) },
    );

    const transfers = result.data.bridgeTransfers ?? [];
    const caveats: string[] = [];
    if (transfers.length === 0) caveats.push('No bridge transfers fell inside the window.');
    if (transfers.length === TRANSFER_LIMIT) {
      caveats.push(
        `Hit the ${TRANSFER_LIMIT}-transfer page limit, so flow figures cover the most recent ` +
          `${TRANSFER_LIMIT} transfers rather than the whole window.`,
      );
    }

    const incoming = transfers.filter((t) => t.isOutgoing === false);
    const outgoing = transfers.filter((t) => t.isOutgoing === true);
    const inUsd = sum(incoming.map((t) => num(t.amountUSD)));
    const outUsd = sum(outgoing.map((t) => num(t.amountUSD)));

    const sourceChains = transfers
      .map((t) => t.fromChainID ?? '')
      .filter((c) => c !== '');
    const routes = transfers
      .filter((t) => (t.fromChainID ?? '') !== '' && (t.toChainID ?? '') !== '')
      .map((t) => ({ key: `${t.fromChainID}->${t.toChainID}`, value: num(t.amountUSD) ?? 0 }));
    const routeTotals = [...sumByKey(routes).values()];

    // A transfer whose recipient is the sender is one actor moving its own
    // capital between chains. Legitimate on its own; a large share of the flow
    // means the "inflow" is one balance sheet, not many participants.
    const selfBridged = transfers.filter(
      (t) =>
        (t.from ?? '').toLowerCase() !== '' &&
        (t.from ?? '').toLowerCase() === (t.transferTo ?? '').toLowerCase(),
    ).length;

    const perSender = sumByKey(
      transfers
        .filter((t) => (t.from ?? '') !== '')
        .map((t) => ({ key: t.from!.toLowerCase(), value: num(t.amountUSD) ?? 0 })),
    );

    const signals: SliceSignal[] = [
      signal('transfer_count', transfers.length, 'count', 'bridge transfers inside the window'),
      signal('inflow_usd', inUsd, 'usd', 'value arriving on this chain'),
      signal('outflow_usd', outUsd, 'usd', 'value leaving this chain'),
      signal(
        'net_flow_usd',
        inUsd !== null && outUsd !== null ? inUsd - outUsd : null,
        'usd',
        'inflow minus outflow; near zero alongside large gross flow means capital passing through',
      ),
      signal(
        'flow_balance',
        ratio(outUsd, inUsd),
        'ratio',
        'outflow over inflow; near 1 means everything that arrived also left',
      ),
      signal(
        'source_chain_count',
        uniqueCount(sourceChains),
        'count',
        'distinct chains the transfers originate from',
      ),
      signal(
        'top_route_share',
        topNShare(routeTotals, 1),
        'share',
        'fraction of bridged value on the single busiest chain pair',
      ),
      signal(
        'route_hhi',
        herfindahl(routeTotals),
        'ratio',
        'Herfindahl over routes; 1 means a single corridor carries everything',
      ),
      signal(
        'self_bridged_share',
        transfers.length > 0 ? selfBridged / transfers.length : null,
        'share',
        'transfers where the recipient is the sender — one actor moving its own capital',
      ),
      signal(
        'top10_bridger_share',
        topNShare([...perSender.values()], 10),
        'share',
        'fraction of bridged value from the ten largest senders',
      ),
      signal(
        'swap_transfer_share',
        transfers.length > 0
          ? transfers.filter((t) => t.isSwap === true).length / transfers.length
          : null,
        'share',
        'transfers that also swapped on arrival',
      ),
    ];

    return {
      sliceId: bridgeSlice.id,
      summary: buildSummary(
        `Cross-chain flow over the last ${ctx.windowDays ?? 30} days.`,
        [
          `${incoming.length} inbound and ${outgoing.length} outbound transfers across ` +
            `${uniqueCount(sourceChains)} source chains.`,
        ],
        signals,
        caveats,
      ),
      signals,
      raw: transfers,
      queryCostUsd: result.cost.usd ?? 0,
      sources: [subgraphId],
      queryCount: 1,
      caveats,
    };
  },
};
