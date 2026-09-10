/**
 * Turning a settlement into actual transfers.
 *
 * `core` settles in abstract units and floating point. The chain moves whole
 * tinybar. Bridging the two is where money gets quietly created or destroyed,
 * so the whole conversion is one pure function with the rounding rule stated
 * out loud and tested.
 *
 * THE ROUNDING RULE: every agent is rounded DOWN, and the asker receives the
 * exact remainder.
 *
 * Rounding agents down can only ever pay an agent a fraction of a tinybar less
 * than the real number says. Rounding up, or rounding to nearest, can make the
 * payouts sum to more than the treasury actually holds — and the treasury holds
 * exactly the deposit plus the bonds, nothing more. The asker then absorbs the
 * dust by construction rather than by luck, which is also what makes the
 * accounting identity hold in integers:
 *
 *     deposit + Σ bonds  ==  Σ agent transfers + asker refund
 *
 * That identity is asserted here before a single transfer is executed. A plan
 * that does not balance is never sent.
 */
import type { MarketParams, Settlement } from '@ethonline/core';
import { unitsToTinybar } from './pricing.js';

export interface TransferLine {
  /** `agent-07`, or `asker`. */
  readonly beneficiary: string;
  readonly accountId: string;
  readonly amountTinybar: bigint;
  /** What this line is made of, for the settlement view in STEP 30. */
  readonly bondReturnedTinybar: bigint;
  readonly payoutTinybar: bigint;
  readonly kind: 'scored' | 'flat-fee' | 'not-drawn' | 'timed-out' | 'asker';
}

export interface TransferPlan {
  readonly marketId: string;
  /** Everything the treasury took in for this market. */
  readonly totalInTinybar: bigint;
  /** Lines with a positive amount. Zero-value lines are dropped. */
  readonly lines: readonly TransferLine[];
  readonly totalOutTinybar: bigint;
  /** Bonds kept because the agent never answered. Stays with the treasury. */
  readonly slashedTinybar: bigint;
}

export interface PlanInput {
  readonly marketId: string;
  readonly settlement: Settlement;
  readonly params: MarketParams;
  readonly hbarPerUnit: number;
  /** Every agent that posted a bond, and where to pay it back. */
  readonly bondAccounts: ReadonlyMap<string, string>;
  /** Agents that were drawn and did not answer. Their bond is forfeit. */
  readonly timedOutAgents: readonly string[];
  /** Agents that bonded but were never drawn. Full refund, no score. */
  readonly notDrawnAgents: readonly string[];
  readonly askerAccountId: string;
  /** What the asker actually paid, in tinybar. The authoritative figure. */
  readonly depositTinybar: bigint;
}

/**
 * Builds the transfer plan.
 *
 * Throws rather than returning a plan that does not balance: a settlement that
 * cannot be paid out is a bug in the mechanism, and executing half of it would
 * turn a bug into lost money.
 */
export function buildTransferPlan(input: PlanInput): TransferPlan {
  const { settlement, params, hbarPerUnit, bondAccounts } = input;
  const bond = unitsToTinybar(params.bondAmount, hbarPerUnit);

  const timedOut = new Set(input.timedOutAgents);
  const lines: TransferLine[] = [];

  const payoutByAgent = new Map(settlement.payouts.map((p) => [p.agentId, p]));

  for (const [agentId, accountId] of bondAccounts) {
    if (timedOut.has(agentId)) {
      // Bond slashed in full. It does NOT go to another agent — PLAN section 5,
      // rule 4 — it stays with the treasury and flows back to the asker.
      lines.push({
        beneficiary: agentId,
        accountId,
        amountTinybar: 0n,
        bondReturnedTinybar: 0n,
        payoutTinybar: 0n,
        kind: 'timed-out',
      });
      continue;
    }

    const payout = payoutByAgent.get(agentId);
    if (!payout) {
      // Bonded, never drawn: the bond comes straight back.
      lines.push({
        beneficiary: agentId,
        accountId,
        amountTinybar: bond,
        bondReturnedTinybar: bond,
        payoutTinybar: 0n,
        kind: 'not-drawn',
      });
      continue;
    }

    // `core` guarantees a loss never exceeds the bond (settlement invariant 5),
    // so this is never negative. Clamped anyway against float dust.
    const net = Math.max(0, params.bondAmount + payout.amount);
    const netTinybar = floorUnits(net, hbarPerUnit);
    lines.push({
      beneficiary: agentId,
      accountId,
      amountTinybar: netTinybar,
      bondReturnedTinybar: bond,
      payoutTinybar: netTinybar - bond,
      kind: payout.kind,
    });
  }

  const paidToAgents = lines.reduce((sum, l) => sum + l.amountTinybar, 0n);
  const totalIn = input.depositTinybar + bond * BigInt(bondAccounts.size);

  // The asker takes the remainder exactly, dust included. This is what keeps
  // the identity exact in integers instead of approximately right in floats.
  const askerRefund = totalIn - paidToAgents;
  if (askerRefund < 0n) {
    throw new Error(
      `Settlement for ${input.marketId} pays out ${paidToAgents} tinybar but only ` +
        `${totalIn} came in. The mechanism's budget bound has been violated — ` +
        `refusing to execute a plan that cannot be funded.`,
    );
  }

  // THE ASKER GOES LAST, AND THAT ORDERING IS LOAD-BEARING.
  //
  // Hedera caps how many accounts one transfer may touch, so this plan is paid
  // as several transactions that are not atomic with respect to each other. A
  // settlement can therefore stop partway through, and whoever sits in the
  // unpaid tail is the one left waiting.
  //
  // Agents are strangers whose bonds are locked until they are paid; the asker
  // is the party that started the market and whose deposit funds it. If
  // somebody has to wait for a resume, it should be the asker. Moving this
  // line earlier would silently reverse that.
  const allLines = [
    ...lines,
    {
      beneficiary: 'asker',
      accountId: input.askerAccountId,
      amountTinybar: askerRefund,
      bondReturnedTinybar: 0n,
      payoutTinybar: askerRefund,
      kind: 'asker' as const,
    },
  ];

  const plan: TransferPlan = {
    marketId: input.marketId,
    totalInTinybar: totalIn,
    lines: allLines.filter((l) => l.amountTinybar > 0n),
    totalOutTinybar: paidToAgents + askerRefund,
    slashedTinybar: bond * BigInt(timedOut.size),
  };

  assertPlanBalances(plan);
  return plan;
}

/** Rounds down to whole tinybar. See the rounding note at the top. */
function floorUnits(units: number, hbarPerUnit: number): bigint {
  if (!Number.isFinite(units) || units < 0) {
    throw new Error(`Cannot convert ${units} units to tinybar.`);
  }
  return BigInt(Math.floor(units * hbarPerUnit * 100_000_000));
}

/**
 * The one check that matters: nothing is created and nothing disappears.
 *
 * Exact integer equality, not a tolerance. Tinybar are whole numbers, so
 * "close enough" here would be hiding a real leak.
 */
export function assertPlanBalances(plan: TransferPlan): void {
  const out = plan.lines.reduce((sum, l) => sum + l.amountTinybar, 0n);
  if (out !== plan.totalOutTinybar) {
    throw new Error(
      `Transfer plan for ${plan.marketId} is inconsistent: lines sum to ${out} ` +
        `but totalOut says ${plan.totalOutTinybar}.`,
    );
  }
  if (plan.totalOutTinybar !== plan.totalInTinybar) {
    throw new Error(
      `Transfer plan for ${plan.marketId} does not balance: ${plan.totalInTinybar} in, ` +
        `${plan.totalOutTinybar} out (difference ${plan.totalInTinybar - plan.totalOutTinybar}).`,
    );
  }
  for (const line of plan.lines) {
    if (line.amountTinybar < 0n) {
      throw new Error(`Transfer plan has a negative line for ${line.beneficiary}.`);
    }
  }
}

/**
 * Splits a plan into transactions the network will accept.
 *
 * Hedera caps how many account entries a single transfer may touch, and one
 * settlement can involve twenty agents plus the asker. Each chunk is one
 * atomic transaction: the treasury debit and that chunk's credits succeed or
 * fail together.
 *
 * Chunks are NOT atomic with respect to each other. That is a real limitation
 * and it is why `executeSettlement` records what it has already sent — a
 * retry has to resume rather than start over.
 */
export function chunkPlan(plan: TransferPlan, maxCreditsPerTransaction = 9): TransferLine[][] {
  if (maxCreditsPerTransaction < 1) {
    throw new Error(`maxCreditsPerTransaction must be >= 1, got: ${maxCreditsPerTransaction}`);
  }
  const chunks: TransferLine[][] = [];
  for (let i = 0; i < plan.lines.length; i += maxCreditsPerTransaction) {
    chunks.push(plan.lines.slice(i, i + maxCreditsPerTransaction));
  }
  return chunks;
}
