/**
 * The twenty-agent pool — STEP 21.
 *
 * THE SLICE ASSIGNMENT IS THE MECHANISM, NOT DECORATION. Assumption 4 in the
 * paper requires agent signals to be conditionally independent given the
 * outcome. Twenty agents reading the same rows and computing the same figure
 * are, for the mechanism's purposes, one agent with twenty votes: the
 * Bhattacharyya coefficient goes to 1 and the `k` Theorem 1 demands goes to
 * infinity with it. The market would still run and its honesty guarantee would
 * mean nothing.
 *
 * So no two agents in this pool get the same set of slices. With five slices
 * there are 31 non-empty subsets and we need twenty, which is comfortable:
 * every agent sees a combination nobody else sees. That is a far stronger
 * answer to Assumption 4 than four agents per slice would be, and it is
 * checked by a test rather than asserted here.
 *
 * WE DO NOT CLAIM ASSUMPTION 4 HOLDS. Distinct subsets of five slices still
 * share underlying rows, and PLAN section 14 says exactly that out loud. What
 * we claim is that the pool is built to approach it.
 *
 * NOTHING HERE IS BAKED INTO THE PROTOCOL. `apps/api` has no idea this file
 * exists; registration is open to anyone (PLAN section 3.3) and this is just
 * how the demo happens to seed the pool.
 */
import type { AgentAccount } from '@ethonline/hedera';
import type { AgentBehavior, AgentConfig } from './runner.js';

/** The five slices, in the order STEP 19 defined them. */
export const POOL_SLICE_IDS = [
  'liquidity',
  'holders',
  'activity',
  'bridge',
  'comparative',
] as const;

export type PoolSliceId = (typeof POOL_SLICE_IDS)[number];

/**
 * What each slice makes an agent good at.
 *
 * These feed the persona, and the persona is the second axis of separation:
 * two agents holding overlapping slices still read them with different
 * priorities. The slice decides what it sees; the persona decides what it
 * weighs.
 */
const SLICE_LENS: Record<PoolSliceId, string> = {
  liquidity:
    'pool depth, how concentrated the TVL is, and how fast capital turns over relative to the fees it earns',
  holders:
    'who the depositors are, how concentrated the inflow is, and how many addresses arrive once and never return',
  activity:
    'the timing of transactions, whether senders trade with themselves, and how regular the intervals look',
  bridge:
    'cross-chain inflow and outflow, how concentrated the routes are, and how much of it returns to its origin',
  comparative:
    'where this protocol sits against its peers on the same standardized schema, by percentile rather than in absolute terms',
};

/**
 * Every non-empty subset of the five slices, ordered so the pool is spread.
 *
 * Singletons first, then pairs, then triples. Taking the first twenty gives
 * full single-slice coverage, every pair, and five triples — so no slice is
 * over-represented and no agent duplicates another.
 */
export function sliceSubsets(): PoolSliceId[][] {
  const ids = [...POOL_SLICE_IDS];
  const bySize: PoolSliceId[][][] = [[], [], [], [], [], []];
  for (let mask = 1; mask < 1 << ids.length; mask++) {
    const subset = ids.filter((_, i) => (mask >> i) & 1);
    bySize[subset.length]!.push(subset);
  }
  return [...bySize[1]!, ...bySize[2]!, ...bySize[3]!, ...bySize[4]!, ...bySize[5]!];
}

export function buildPersona(sliceIds: readonly PoolSliceId[]): string {
  const lenses = sliceIds.map((id) => SLICE_LENS[id]);
  const head =
    sliceIds.length === 1
      ? `You look at exactly one thing: ${lenses[0]}.`
      : `You look at ${sliceIds.length} things and nothing else: ${lenses.join('; and ')}.`;
  return [
    head,
    '',
    'You do not see what the other analysts see. When their reports disagree',
    'with yours, that is information about their evidence, not proof that',
    'yours is wrong. Update on it in proportion to how much of the question',
    'your own evidence can actually settle.',
  ].join('\n');
}

export interface BuildPoolOptions {
  /** Agent id -> behaviour. Absent means `honest`. Demo scenarios only. */
  readonly behaviors?: Readonly<Record<string, AgentBehavior>>;
  /** Cap the pool. Defaults to every account supplied. */
  readonly limit?: number;
}

/**
 * Turns the Hedera accounts file into a pool of configured agents.
 *
 * Throws rather than truncating if there are more accounts than distinct slice
 * subsets. Silently giving two agents the same subset is the one failure this
 * file exists to prevent, and it would be invisible afterwards.
 */
export function buildAgentPool(
  accounts: readonly AgentAccount[],
  opts: BuildPoolOptions = {},
): AgentConfig[] {
  const subsets = sliceSubsets();
  const take = Math.min(opts.limit ?? accounts.length, accounts.length);

  if (take > subsets.length) {
    throw new Error(
      `${take} agents requested but only ${subsets.length} distinct slice subsets exist. ` +
        `Two agents sharing a subset is one agent with two votes — see Assumption 4.`,
    );
  }

  return accounts.slice(0, take).map((account, i) => {
    const sliceIds = subsets[i]!;
    const behavior = opts.behaviors?.[account.agentId];
    return {
      id: account.agentId,
      accountId: account.accountId,
      privateKey: account.privateKey,
      publicKey: account.publicKey,
      sliceIds,
      persona: buildPersona(sliceIds),
      ...(behavior ? { behavior } : {}),
    };
  });
}
