/**
 * The API.
 *
 * WHAT IS PAID FOR AND WHAT IS NOT, AND WHY THE SPLIT FALLS WHERE IT DOES.
 *
 *   Paid (x402):  opening a market, posting a bond, buying a resolution.
 *                 Each of these is money entering the mechanism, so the
 *                 payment IS the action — there is nothing to authenticate
 *                 separately.
 *
 *   Signed:       reports. No money moves, so payment cannot prove authorship;
 *                 the agent signs with the same key it bonded with. There is
 *                 no route for them: the orchestrator requests each report
 *                 from the drawn agent and verifies it there. See
 *                 `signatures.ts` and `orchestrator.ts`.
 *
 *   Open:         everything readable, plus agent registration. PLAN section
 *                 3.3 — registration is open to anyone, and this demo merely
 *                 seeds the pool. There is no allowlist anywhere in here.
 *
 * The payment middleware is injected rather than constructed here. That is
 * what lets the whole route surface be tested offline: unit tests build the
 * app with an open gate and cover the logic, and STEP 17 runs the real x402
 * flow against testnet. The alternative — reaching for the facilitator inside
 * `createApp` — would leave every route untested until day six.
 */
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import {
  assertValidParams,
  beliefFromProbability,
  DEFAULT_PARAMS,
  Market,
  maxTotalPayout,
  normalizeBelief,
  requiredDeposit,
  UNIFORM_PRIOR,
  type Belief,
  type MarketParams,
} from '@ethonline/core';
import { PublicKey } from '@hashgraph/sdk';
import { HcsRandomSource, type HcsMessage, type HederaNetwork } from '@ethonline/hedera';
import type { Ledger } from './ledger.js';
import {
  bondTinybar,
  depositTinybar,
  DEFAULT_HBAR_PER_UNIT,
  DEFAULT_PROTOCOL_FEE_TINYBAR,
  marketPriceTinybar,
  unitsToTinybar,
} from './pricing.js';
import { summarize } from './settlement-progress.js';
import { verifyRegistrationSignature } from './signatures.js';
import { onPaymentFailure } from './payment-rollback.js';
import { agentRecords, recordFor } from './reputation.js';
import {
  buildResolveAnswer,
  findAnsweredMarket,
  findPendingMarket,
  questionKey,
} from './resolve.js';
import {
  AgentRegistry,
  MarketStore,
  nextMarketId,
  type RegisteredAgent,
  type StoredMarket,
} from './store.js';

export interface ApiConfig {
  readonly network: HederaNetwork;
  readonly hbarPerUnit: number;
  /** How long agents have to bond after a market opens. */
  readonly bondingWindowMs: number;
  /**
   * The floor on that window, even after the pool is full.
   *
   * WITHOUT THIS THE POOL IS OPEN IN NAME ONLY. The runner used to close
   * bonding the moment `minPoolSize` was reached, and the twenty agents this
   * deployment runs bond within seconds of a market opening. Registration was
   * open to anyone and a stranger could still never get in, because the door
   * shut before they saw the market. Nothing in the code refused them; the
   * timing did, which is worse, because it looks like openness.
   */
  readonly minBondingWindowMs: number;
  readonly defaultParams: MarketParams;
  /**
   * Charged to the asker on top of the deposit, and kept.
   *
   * It sits OUTSIDE the settlement pot on purpose: the mechanism's honesty
   * guarantee is a statement about the scoring payments, and a fee taken out
   * of those would change the payoff function agents are reasoning about. This
   * one is a price at the door, quoted in the 402 before anything is paid.
   */
  readonly protocolFeeTinybar: bigint;
}

export const DEFAULT_API_CONFIG: ApiConfig = {
  network: 'testnet',
  hbarPerUnit: DEFAULT_HBAR_PER_UNIT,
  bondingWindowMs: 5 * 60 * 1000,
  minBondingWindowMs: 45 * 1000,
  protocolFeeTinybar: DEFAULT_PROTOCOL_FEE_TINYBAR,
  defaultParams: DEFAULT_PARAMS,
};

/**
 * Checks that an agent registering an ENS name actually holds it.
 *
 * Injected rather than imported so `createApp` still reaches for nothing: the
 * unit suite hands it a stub, and `server.ts` hands it a reader pointed at
 * Sepolia. A deployment with no verifier refuses ENS names outright rather
 * than displaying one it cannot check — an unearned name on an agent card is
 * worse than no name at all.
 */
export type EnsVerifier = (
  name: string,
  expectedOwner: string,
) => Promise<{ ok: boolean; reason?: string }>;

export interface AppDeps {
  readonly ledger: Ledger;
  readonly registry?: AgentRegistry;
  readonly markets?: MarketStore;
  readonly config?: Partial<ApiConfig>;
  /** x402 middleware in production; omitted in unit tests. */
  readonly paymentGate?: RequestHandler;
  readonly verifyEnsName?: EnsVerifier;
  readonly now?: () => number;
}

export interface Api {
  readonly app: Express;
  readonly registry: AgentRegistry;
  readonly markets: MarketStore;
  readonly config: ApiConfig;
}

// ------------------------------------------------------------- small helpers

function fail(res: Response, status: number, error: string, detail?: string): void {
  res.status(status).json(detail === undefined ? { error } : { error, detail });
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** `0.0.1234`. Rejects anything else so a typo cannot swallow a refund. */
export function parseAccountId(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return /^\d+\.\d+\.\d+$/.test(trimmed) ? trimmed : undefined;
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`"${name}" must be a non-empty string.`);
  }
  return v.trim();
}

/**
 * Merges caller-supplied parameters over the protocol defaults.
 *
 * Unknown keys are ignored rather than rejected: a caller sending an extra
 * field should not have its market refused, but it must not be able to smuggle
 * a value into the mechanism either.
 */
export function resolveParams(raw: unknown, defaults: MarketParams): MarketParams {
  const o = asRecord(raw);
  const pick = (key: keyof MarketParams): number => {
    const v = o[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : defaults[key];
  };
  return {
    k: pick('k'),
    T: pick('T'),
    alpha: pick('alpha'),
    epsilon: pick('epsilon'),
    b: pick('b'),
    R: pick('R'),
    minPoolSize: pick('minPoolSize'),
    bondAmount: pick('bondAmount'),
  };
}

export function resolvePrior(raw: unknown): Belief {
  if (raw === undefined || raw === null) return UNIFORM_PRIOR;
  if (Array.isArray(raw) && raw.length === 2) {
    return normalizeBelief([Number(raw[0]), Number(raw[1])]);
  }
  if (typeof raw === 'number') return beliefFromProbability(raw);
  throw new Error('"prior" must be a probability or a two-element array.');
}

/** What a market looks like from outside. No keys, no bond amounts per agent. */
export function publicMarketView(m: StoredMarket): Record<string, unknown> {
  const state = m.market.getState();
  return {
    marketId: m.id,
    question: m.question,
    status: state.status,
    topicId: m.topicId,
    params: m.params,
    prior: m.prior,
    currentPrice: m.market.currentPrice(),
    reportCount: state.reports.length,
    bondedCount: m.bonds.size,
    // Deliberately absent: who has been drawn, and who is pending. Publishing
    // the order would tell the last agent it is the reference before it
    // reports (PLAN section 6.4).
    closedReason: state.closedReason,
    reference: state.referenceReport?.belief,
    depositTinybar: m.depositTinybar.toString(),
    bondTinybar: m.bondTinybar.toString(),
    createdAt: m.createdAt,
    bondingClosesAt: m.bondingClosesAt,
    minBondingClosesAt: m.minBondingClosesAt,
  };
}


/** What the asker gets back, in tinybar. Zero if the plan has no asker line. */
function askerLine(plan: { lines: readonly { beneficiary: string; amountTinybar: bigint }[] }): bigint {
  return plan.lines.find((l) => l.beneficiary === 'asker')?.amountTinybar ?? 0n;
}

// -------------------------------------------------------------------- the app

export function createApp(deps: AppDeps): Api {
  const config: ApiConfig = { ...DEFAULT_API_CONFIG, ...deps.config };
  const registry = deps.registry ?? new AgentRegistry();
  const markets = deps.markets ?? new MarketStore();
  const now = deps.now ?? (() => Date.now());

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  if (deps.paymentGate) app.use(deps.paymentGate);

  // ---------------------------------------------------------------- health
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      network: config.network,
      markets: markets.size,
      agents: registry.size,
      // What a default market costs to open here, split into the part the
      // mechanism spends and the part this deployment keeps. The Ask page
      // reads it rather than assuming a fee of zero.
      depositTinybar: depositTinybar(
        config.defaultParams,
        UNIFORM_PRIOR,
        config.hbarPerUnit,
      ).toString(),
      protocolFeeTinybar: config.protocolFeeTinybar.toString(),
    });
  });

  // ------------------------------------------------------- agent registry
  //
  // Open by design. Nothing here checks a list of "our" agents.
  app.post('/agents/register', (req, res) => {
    const body = asRecord(req.body);
    let agent: RegisteredAgent;
    try {
      agent = {
        agentId: requireString(body['agentId'], 'agentId'),
        accountId: requireString(body['accountId'], 'accountId'),
        publicKey: requireString(body['publicKey'], 'publicKey'),
        ...(typeof body['endpoint'] === 'string' ? { endpoint: body['endpoint'] } : {}),
        ...(typeof body['ensName'] === 'string' ? { ensName: body['ensName'] } : {}),
        ...(Array.isArray(body['sliceIds'])
          ? { sliceIds: body['sliceIds'].filter((s): s is string => typeof s === 'string') }
          : {}),
        registeredAt: now(),
      };
    } catch (e) {
      return fail(res, 400, 'Invalid registration', (e as Error).message);
    }

    // Open, but not unauthenticated. Anyone may register anything they hold
    // the key for; nobody may register a key they do not hold. Without this a
    // stranger could squat an agent id, or re-register a live agent's endpoint
    // to a server they control — the victim then gets drawn, answers nothing
    // and loses its whole bond. See signatures.ts.
    const signature = typeof body['signature'] === 'string' ? body['signature'] : undefined;
    const issuedAt = Number(body['issuedAt']);
    if (!signature || !Number.isFinite(issuedAt)) {
      return fail(
        res,
        400,
        'Invalid registration',
        'A registration must carry "signature" and "issuedAt": sign the canonical ' +
          'registration message with the key you are registering.',
      );
    }
    const proof = verifyRegistrationSignature(
      {
        agentId: agent.agentId,
        accountId: agent.accountId,
        publicKey: agent.publicKey,
        ...(agent.endpoint ? { endpoint: agent.endpoint } : {}),
        ...(agent.sliceIds ? { sliceIds: agent.sliceIds } : {}),
        issuedAt,
      },
      signature,
      now(),
    );
    if (!proof.ok) return fail(res, 401, 'Registration is not signed by its own key', proof.reason);

    // An ENS name is a claim about a second chain, so it is checked against
    // that chain rather than against the signature above.
    //
    // The signature proves the key; the registry lookup proves the name is
    // owned by the address that key derives. Signing the name as well would
    // add nothing: a signature says "I claim this name", the lookup says "the
    // name is mine", and only the second one is worth displaying.
    void (async () => {
      if (agent.ensName) {
        if (!deps.verifyEnsName) {
          return fail(
            res,
            400,
            'ENS names cannot be verified here',
            'This deployment has no ENS reader configured, so it will not display a name it ' +
              'cannot check. Register without ensName.',
          );
        }
        let expectedOwner: string;
        try {
          expectedOwner = `0x${PublicKey.fromString(agent.publicKey).toEvmAddress()}`;
        } catch (e) {
          return fail(res, 400, 'Invalid registration', `Public key is unusable: ${(e as Error).message}`);
        }
        const check = await deps.verifyEnsName(agent.ensName, expectedOwner);
        if (!check.ok) {
          return fail(
            res,
            401,
            'That ENS name is not yours',
            check.reason ?? `${agent.ensName} is not owned by ${expectedOwner}.`,
          );
        }
      }

      try {
        const saved = registry.register(agent);
        return void res.status(201).json({ agent: saved, agentCount: registry.size });
      } catch (e) {
        return fail(res, 409, 'Registration conflict', (e as Error).message);
      }
    })();
  });

  app.get('/agents', (_req, res) => {
    // Identity and record in one response. The directory needs both, and two
    // endpoints would mean the page renders an agent whose record arrives a
    // moment later — a card that changes under the reader for no reason.
    const records = agentRecords(markets);
    res.json({
      agents: registry.list().map((a) => ({ ...a, record: recordFor(records, a.agentId) })),
      count: registry.size,
    });
  });

  // --------------------------------------------------------- open a market
  //
  // Paid. The price the client was quoted is `depositTinybar` computed from
  // this same body by the same function the gate used, so the two cannot drift.
  app.post('/market', (req, res) => {
    void (async () => {
      const body = asRecord(req.body);

      let question: string;
      let params: MarketParams;
      let prior: Belief;
      try {
        question = requireString(body['question'], 'question');
        params = resolveParams(body['params'], config.defaultParams);
        prior = resolvePrior(body['prior']);
        assertValidParams(params);
      } catch (e) {
        return fail(res, 400, 'Invalid market request', (e as Error).message);
      }

      // `issued`, not `size`: a market rolled back for an unsettled deposit
      // must not lend its number to the next one.
      const id = nextMarketId(markets.issued, new Date(now()));
      const deposit = depositTinybar(params, prior, config.hbarPerUnit);
      const bond = bondTinybar(params, config.hbarPerUnit);

      try {
        const topicId = await deps.ledger.createTopic(`ethonline market ${id}`);

        const open: HcsMessage = {
          v: 1,
          type: 'market-open',
          marketId: id,
          ts: now(),
          question,
          prior,
          params: {
            k: params.k,
            T: params.T,
            alpha: params.alpha,
            epsilon: params.epsilon,
            b: params.b,
            R: params.R,
          },
        };
        const appended = await deps.ledger.append(topicId, open);

        // The randomness source starts from the opening message's running
        // hash, so the very first agent draw is already unpredictable.
        const rng = new HcsRandomSource(appended.runningHash);
        const market = Market.create({ id, question, params, prior }, rng);

        const stored = markets.add({
          id,
          question,
          topicId,
          params,
          prior,
          market,
          rng,
          depositTinybar: deposit,
          bondTinybar: bond,
          // Optional: a market opened without one still runs, and settlement
          // then has nowhere to send the refund. See StoredMarket.
          ...(parseAccountId(body['askerAccountId'])
            ? { askerAccountId: parseAccountId(body['askerAccountId'])! }
            : {}),
          createdAt: now(),
          bondingClosesAt: now() + config.bondingWindowMs,
          minBondingClosesAt: now() + config.minBondingWindowMs,
          bonds: new Map(),
          annotations: new Map(),
        });

        // The deposit has NOT been paid yet at this point: the x402 gate
        // settles after this handler returns. If that settlement fails the
        // market must not survive, or agents would bond into a market nobody
        // funded. See payment-rollback.ts.
        onPaymentFailure(res, `market ${stored.id} (deposit never settled)`, () => {
          markets.remove(stored.id);
        });

        return void res.status(201).json({
          marketId: stored.id,
          topicId,
          bondingClosesAt: stored.bondingClosesAt,
          params,
          prior,
          // `deposit` is what funds the market and is what settlement may
          // spend. `paid` is what the asker was charged. The difference is the
          // protocol fee, and saying both is the honest way to charge one.
          depositTinybar: deposit.toString(),
          protocolFeeTinybar: config.protocolFeeTinybar.toString(),
          paidTinybar: (deposit + config.protocolFeeTinybar).toString(),
          bondTinybar: bond.toString(),
        });
      } catch (e) {
        return fail(res, 502, 'Could not open the market on chain', (e as Error).message);
      }
    })();
  });

  // ------------------------------------------------------------ post a bond
  app.post('/market/:id/bond', (req, res) => {
    const stored = markets.get(String(req.params['id']));
    if (!stored) return fail(res, 404, 'No such market');

    const body = asRecord(req.body);
    let agentId: string;
    try {
      agentId = requireString(body['agentId'], 'agentId');
    } catch (e) {
      return fail(res, 400, 'Invalid bond request', (e as Error).message);
    }

    const agent = registry.get(agentId);
    if (!agent) {
      return fail(res, 404, 'Unknown agent', `Register ${agentId} before bonding.`);
    }
    if (stored.market.status !== 'bonding') {
      return fail(
        res,
        409,
        'Bonding is closed',
        `Market ${stored.id} is ${stored.market.status}.`,
      );
    }
    if (stored.bonds.has(agentId)) {
      return fail(res, 409, 'Already bonded', `${agentId} has already joined this market.`);
    }

    try {
      // `core` enforces the one-market-one-entry rule; this is the second line
      // of defence, not the only one.
      stored.market.addBondedAgent(agentId);
    } catch (e) {
      return fail(res, 409, 'Could not bond', (e as Error).message);
    }

    stored.bonds.set(agentId, {
      agentId,
      accountId: agent.accountId,
      paidTinybar: stored.bondTinybar,
      bondedAt: now(),
    });

    // Same as above, and this is the one that actually bit: a bond recorded
    // against a payment that never settled puts an unfunded agent in the pool
    // and settlement pays its bond back out of the treasury.
    onPaymentFailure(res, `bond for ${agentId} on ${stored.id} (never settled)`, () => {
      stored.bonds.delete(agentId);
      stored.market.removeBondedAgent(agentId);
    });

    return void res.status(201).json({
      // Null on purpose, and it stays null. An agent that knew its position
      // before the market ran would know whether it could be the reference,
      // which is exactly the leak the lazy draw exists to prevent.
      position: null,
      bondedCount: stored.bonds.size,
      minPoolSize: stored.params.minPoolSize,
    });
  });

  // ------------------------------------------------------------- reports
  //
  // There is deliberately no route for posting a report. The orchestrator asks
  // the drawn agent at its registered endpoint and verifies the signed answer
  // itself (orchestrator.ts), inside the round it is running.
  //
  // A public route used to exist as well, and it was a way to break a market.
  // The drawn agent could answer here instead of to the orchestrator: the
  // report landed with no stopping roll, the orchestrator's own submit then
  // threw because the turn had already moved on, and the runner left the market
  // `running` for good, with the deposit and every bond stuck in the treasury.
  // One way in, and one place that decides what a round is.

  // ------------------------------------------------------------ public reads
  app.get('/markets', (_req, res) => {
    res.json({ markets: markets.list().map(publicMarketView), count: markets.size });
  });

  app.get('/market/:id', (req, res) => {
    const stored = markets.get(String(req.params['id']));
    if (!stored) return fail(res, 404, 'No such market');
    return void res.json(publicMarketView(stored));
  });

  app.get('/market/:id/reports', (req, res) => {
    const stored = markets.get(String(req.params['id']));
    if (!stored) return fail(res, 404, 'No such market');
    const state = stored.market.getState();
    let previous = stored.prior;
    const reports = state.reports.map((r) => {
      const annotation = stored.annotations.get(r.position);
      const row = {
        position: r.position,
        agentId: r.agentId,
        belief: r.belief,
        rawBelief: r.rawBelief,
        // Where the price was before this agent moved it. The scoring rule
        // pays for the MOVE, not the level, so a report only means anything
        // next to the one before it.
        previousBelief: previous,
        clipped: r.belief[1] !== r.rawBelief[1],
        timestamp: r.timestamp,
        ...(annotation?.reasoning ? { reasoning: annotation.reasoning } : {}),
        ...(annotation?.sliceIds ? { sliceIds: annotation.sliceIds } : {}),
        ...(typeof annotation?.evidenceCostUsd === 'number'
          ? { evidenceCostUsd: annotation.evidenceCostUsd }
          : {}),
        ...(annotation?.evidenceDigest ? { evidenceDigest: annotation.evidenceDigest } : {}),
      };
      previous = r.belief;
      return row;
    });

    return void res.json({
      marketId: stored.id,
      topicId: stored.topicId,
      prior: stored.prior,
      reports,
      // Anyone can recompute all of this from the topic without trusting us.
      verifyVia: `${stored.topicId}`,
    });
  });

  /**
   * The randomness behind the decisions already made.
   *
   * WHY THIS IS WORTH AN ENDPOINT. The mechanism's honesty rests on the
   * stopping time being unpredictable, and the only reason to believe ours is
   * that each roll comes from the running hash of a message that did not exist
   * until the network agreed on it. That claim is checkable — the hashes are
   * public on the mirror node — but only if we say which hash decided what.
   *
   * ONLY THE PAST. A draw is published once the report at that position
   * exists. The draw for an agent that has been picked but has not reported
   * yet stays hidden, because publishing it alongside the pool would say who
   * is about to speak; the whole reason the draw is lazy is that nobody may
   * learn the order in advance (PLAN section 6.4).
   */
  app.get('/market/:id/randomness', (req, res) => {
    const stored = markets.get(String(req.params['id']));
    if (!stored) return fail(res, 404, 'No such market');
    const state = stored.market.getState();
    const settledPositions = state.reports.length;

    const positionOf = (label: string): number => Number(label.split('-')[1] ?? '0');

    const draws = stored.rng.draws
      .filter((d) => positionOf(d.label) <= settledPositions)
      .map((d) => ({
        label: d.label,
        purpose: d.purpose,
        position: positionOf(d.label),
        runningHash: d.runningHashHex,
        value: d.value,
        // A stopping roll closes the market when it lands below alpha. Stated
        // per draw so a reader can check the comparison, not just trust it.
        ...(d.purpose === 'stop'
          ? { alpha: stored.params.alpha, stopped: d.value < stored.params.alpha }
          : {}),
      }));

    return void res.json({
      marketId: stored.id,
      topicId: stored.topicId,
      alpha: stored.params.alpha,
      draws,
      pendingHidden: stored.rng.draws.length > draws.length,
      howToVerify:
        'Each running hash is public on the mirror node. Take the 8 bytes at offset 0 for a ' +
        'stopping roll (offset 8 for a draw), read them big-endian, keep the top 53 bits and ' +
        'divide by 2^53. A stopping roll below alpha closed the market.',
    });
  });

  /**
   * Where the money went, and the proof it could not have been more.
   *
   * THE BUDGET BOUND IS THE POINT. The paper's §6.2 telescoping argument says
   * the asker's whole CE-MSR subsidy is capped at `b·H(r, q⁰)` no matter how
   * long the market runs or how wildly the price moves — the intermediate
   * terms cancel. That is the claim that makes it safe to open a market at
   * all, and it is checkable: the cap and what was actually paid are both
   * numbers, and this endpoint publishes both.
   *
   * ALWAYS 200 FOR A MARKET THAT EXISTS. A page polling this while a market is
   * still running should learn that it has not settled, not collect 404s.
   */
  app.get('/market/:id/settlement', (req, res) => {
    const stored = markets.get(String(req.params['id']));
    if (!stored) return fail(res, 404, 'No such market');

    const state = stored.market.getState();
    const progress = stored.settlementProgress;

    if (!progress) {
      return void res.json({
        marketId: stored.id,
        status: 'not-settled',
        marketStatus: state.status,
      });
    }

    const { settlement, plan } = progress;
    const summary = summarize(progress);

    // Chunk index per beneficiary, so a line can be tied to the transaction
    // that actually carried it.
    const chunkOf = new Map<string, { index: number; transactionId?: string; state: string }>();
    for (const chunk of progress.chunks) {
      for (const line of chunk.lines) {
        chunkOf.set(line.beneficiary, {
          index: chunk.index,
          ...(chunk.transactionId ? { transactionId: chunk.transactionId } : {}),
          state: chunk.state,
        });
      }
    }

    const scoredTotal = settlement.payouts
      .filter((p) => p.kind === 'scored')
      .reduce((sum, p) => sum + p.amount, 0);

    // Referenced-in bound when the market closed; the referenceless worst case
    // otherwise. Both are real caps — the second is just looser.
    const boundUnits = settlement.reference
      ? maxTotalPayout(stored.params.b, stored.prior, settlement.reference)
      : maxTotalPayout(stored.params.b, stored.prior);

    const inTinybar = plan.totalInTinybar;
    const outTinybar = plan.totalOutTinybar + plan.slashedTinybar;

    return void res.json({
      marketId: stored.id,
      status: summary.complete ? 'complete' : summary.blocked ? 'blocked' : 'in-progress',
      marketStatus: state.status,
      topicId: stored.topicId,
      ...(settlement.reference ? { reference: settlement.reference } : {}),

      payouts: settlement.payouts.map((p) => ({
        agentId: p.agentId,
        position: p.position,
        kind: p.kind,
        amount: p.amount,
        ...(typeof p.scoreRaw === 'number' ? { scoreRaw: p.scoreRaw } : {}),
      })),

      totals: {
        deposit: settlement.deposit,
        totalBonds: settlement.totalBonds,
        scoreTotal: settlement.scoreTotal,
        bondsReturned: settlement.bondsReturned,
        timeoutSlash: settlement.timeoutSlash,
        scoreSlash: settlement.scoreSlash,
        totalToAgents: settlement.totalToAgents,
        askerRefund: settlement.askerRefund,
      },

      /**
       * The cap, what was spent against it, and the deposit that had to cover
       * both it and the flat fees.
       */
      bound: {
        maxScoringUnits: boundUnits,
        actualScoringUnits: scoredTotal,
        flatFeeUnits: settlement.payouts.filter((p) => p.kind === 'flat-fee').length * stored.params.R,
        requiredDepositUnits: requiredDeposit(stored.params, stored.prior),
        withinBound: scoredTotal <= boundUnits + 1e-9,
        maxScoringTinybar: unitsToTinybar(Math.max(0, boundUnits), config.hbarPerUnit).toString(),
      },

      transfers: plan.lines.map((l) => {
        const chunk = chunkOf.get(l.beneficiary);
        return {
          beneficiary: l.beneficiary,
          accountId: l.accountId,
          kind: l.kind,
          amountTinybar: l.amountTinybar.toString(),
          bondReturnedTinybar: l.bondReturnedTinybar.toString(),
          payoutTinybar: l.payoutTinybar.toString(),
          ...(chunk
            ? {
                chunkIndex: chunk.index,
                chunkState: chunk.state,
                ...(chunk.transactionId ? { transactionId: chunk.transactionId } : {}),
              }
            : {}),
        };
      }),

      /**
       * The accounting identity, computed here rather than asserted.
       *
       * `deposit + Σ bonds` must equal `Σ transfers + slashed`. It is checked
       * in `core` before a plan is built and again before it is executed; this
       * publishes the arithmetic so a reader can add it up themselves instead
       * of taking a green tick on faith.
       */
      accounting: {
        inTinybar: inTinybar.toString(),
        outTinybar: outTinybar.toString(),
        paidToAgentsTinybar: (plan.totalOutTinybar - askerLine(plan)).toString(),
        askerRefundTinybar: askerLine(plan).toString(),
        slashedTinybar: plan.slashedTinybar.toString(),
        balances: inTinybar === outTinybar,
      },

      progress: {
        chunks: summary.total,
        sent: summary.sent,
        pending: summary.pending,
        unknown: summary.unknown,
        blocked: summary.blocked,
      },
    });
  });

  // ----------------------------------------------------- resolution service
  //
  // Paid, and the shell of it only. STEP 22 fills this in; it is the piece the
  // Hedera track asks for — a real x402-gated service with a platform that
  // consumes it.
  app.post('/resolve', (req, res) => {
    void (async () => {
      const body = asRecord(req.body);

      let question: string;
      try {
        question = requireString(body['question'], 'question');
      } catch (e) {
        return fail(res, 400, 'Invalid resolution request', (e as Error).message);
      }
      if (questionKey(question).length < 8) {
        return fail(
          res,
          400,
          'Question is too short',
          'A question the mechanism can price needs to say what it is asking about.',
        );
      }

      // Already answered: hand it over, with the topic to check it against.
      const answered = findAnsweredMarket(markets, question);
      if (answered) {
        return void res.json({
          status: 'answered',
          ...buildResolveAnswer(answered, { network: config.network, registry }),
        });
      }

      // Already running: point at it rather than opening a second market for
      // the same question. Two markets on one question split the agents and
      // give two prices, which is the parallel-markets design the paper rules
      // out (PLAN section 6.7).
      const pending = findPendingMarket(markets, question);
      if (pending) {
        return void res.status(202).json({
          status: 'pending',
          marketId: pending.id,
          marketStatus: pending.market.getState().status,
          topicId: pending.topicId,
          watch: `/market/${pending.id}`,
          detail:
            'A market for this question is already running. Poll this endpoint or the market ' +
            'until it closes; the answer is the terminal report.',
        });
      }

      // Nothing yet: refuse, and say how to get an answer. This route charges a
      // flat fee and must never open a market. A market is funded by a deposit
      // of b·H(prior) + k·R that settlement spends; opening one here would pay
      // that out of money nobody put in, with `b` chosen by the caller. The 4xx
      // also means @x402/express cancels the payment, so this costs nothing.
      const deposit = depositTinybar(config.defaultParams, UNIFORM_PRIOR, config.hbarPerUnit);
      return void res.status(404).json({
        error: 'No market has priced this question',
        open: {
          route: 'POST /market',
          body: { question },
          depositTinybar: deposit.toString(),
          protocolFeeTinybar: config.protocolFeeTinybar.toString(),
          priceTinybar: (deposit + config.protocolFeeTinybar).toString(),
        },
        detail:
          'Nothing was charged. Open a market for this question with POST /market, which is ' +
          'priced at the deposit the market needs, then ask again once it has closed.',
      });
    })();
  });

  // Last in the chain, so it sees everything the routes and the payment gate
  // hand off. Express's default handler answers a bare `500 Internal Server
  // Error` with no body, which tells a caller nothing about whether to fix
  // the request or simply retry.
  app.use(errorHandler);

  return { app, registry, markets, config };
}

/** Network-level failures, which mean "try again", not "you did it wrong". */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /fetch failed/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /UND_ERR_CONNECT_TIMEOUT/i,
  /timeout/i,
  /facilitator/i,
  /no supported payment kinds/i,
];

export function isUpstreamFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

/**
 * Turns an unhandled error into an answer a client can act on.
 *
 * WHY IT EXISTS, AND WHY THE WRAPPER AROUND THE GATE WAS NOT ENOUGH. Middleware
 * has two ways to fail: it can throw or reject, which `withFacilitatorErrors`
 * catches, or it can call `next(err)` — and that route goes straight past the
 * wrapper into Express's default handler and comes back as a bare 500. STEP 17
 * hit exactly that: an unreachable facilitator produced a 500 with no body,
 * indistinguishable from a malformed request.
 *
 * A caller has to be able to tell "fix your request" (4xx) from "the machinery
 * is having a moment, retry" (503), because those call for opposite responses.
 */
export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (res.headersSent) return next(err);
  const message = err instanceof Error ? err.message : String(err);

  if (isUpstreamFailure(err)) {
    res.status(503).json({
      error: 'Upstream temporarily unavailable',
      detail: 'The payment or ledger backend could not be reached. Retry shortly.',
      cause: message.slice(0, 200),
    });
    return;
  }
  res.status(500).json({ error: 'Internal error', detail: message.slice(0, 200) });
};
