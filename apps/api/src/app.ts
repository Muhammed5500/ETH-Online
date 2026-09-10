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
 *   Signed:       submitting a report. No money moves, so payment cannot prove
 *                 authorship; the agent signs with the same key it bonded
 *                 with. See `signatures.ts`.
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
  normalizeBelief,
  UNIFORM_PRIOR,
  type Belief,
  type MarketParams,
} from '@ethonline/core';
import { HcsRandomSource, type HcsMessage, type HederaNetwork } from '@ethonline/hedera';
import type { Ledger } from './ledger.js';
import { bondTinybar, depositTinybar, DEFAULT_HBAR_PER_UNIT } from './pricing.js';
import { verifyReportSignature } from './signatures.js';
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
  readonly defaultParams: MarketParams;
}

export const DEFAULT_API_CONFIG: ApiConfig = {
  network: 'testnet',
  hbarPerUnit: DEFAULT_HBAR_PER_UNIT,
  bondingWindowMs: 5 * 60 * 1000,
  defaultParams: DEFAULT_PARAMS,
};

export interface AppDeps {
  readonly ledger: Ledger;
  readonly registry?: AgentRegistry;
  readonly markets?: MarketStore;
  readonly config?: Partial<ApiConfig>;
  /** x402 middleware in production; omitted in unit tests. */
  readonly paymentGate?: RequestHandler;
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
  };
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

    try {
      const saved = registry.register(agent);
      return void res.status(201).json({ agent: saved, agentCount: registry.size });
    } catch (e) {
      return fail(res, 409, 'Registration conflict', (e as Error).message);
    }
  });

  app.get('/agents', (_req, res) => {
    res.json({ agents: registry.list(), count: registry.size });
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

      const id = nextMarketId(markets.size, new Date(now()));
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
          createdAt: now(),
          bondingClosesAt: now() + config.bondingWindowMs,
          bonds: new Map(),
        });

        return void res.status(201).json({
          marketId: stored.id,
          topicId,
          bondingClosesAt: stored.bondingClosesAt,
          params,
          prior,
          depositTinybar: deposit.toString(),
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

    return void res.status(201).json({
      // Null on purpose, and it stays null. An agent that knew its position
      // before the market ran would know whether it could be the reference,
      // which is exactly the leak the lazy draw exists to prevent.
      position: null,
      bondedCount: stored.bonds.size,
      minPoolSize: stored.params.minPoolSize,
    });
  });

  // ---------------------------------------------------------- post a report
  //
  // Free, so the signature is what proves authorship. The agent must already
  // have been drawn — that sequencing is the orchestrator's job (STEP 16).
  app.post('/market/:id/report', (req, res) => {
    void (async () => {
      const stored = markets.get(String(req.params['id']));
      if (!stored) return fail(res, 404, 'No such market');

      const body = asRecord(req.body);
      let agentId: string;
      let signature: string;
      let probability: number;
      try {
        agentId = requireString(body['agentId'], 'agentId');
        signature = requireString(body['signature'], 'signature');
        probability = Number(body['probability']);
        if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
          throw new Error('"probability" must be a number in [0, 1].');
        }
      } catch (e) {
        return fail(res, 400, 'Invalid report', (e as Error).message);
      }

      const agent = registry.get(agentId);
      if (!agent) return fail(res, 404, 'Unknown agent');

      const state = stored.market.getState();
      if (state.status !== 'running') {
        return fail(res, 409, 'Market is not running', `Market ${stored.id} is ${state.status}.`);
      }
      if (state.pendingAgentId !== agentId) {
        return fail(
          res,
          409,
          'Not your turn',
          `The market is waiting for ${state.pendingAgentId ?? 'nobody'}.`,
        );
      }

      // Signed over the RAW probability, before any clipping: that is what the
      // agent committed to, and the clip has to stay independently auditable.
      const position = state.reports.length + 1;
      const rawBelief = beliefFromProbability(probability);
      const check = verifyReportSignature(
        { marketId: stored.id, agentId, position, belief: rawBelief },
        signature,
        agent.publicKey,
      );
      if (!check.ok) return fail(res, 401, 'Bad signature', check.reason);

      let report;
      try {
        report = stored.market.submitReport(agentId, rawBelief);
      } catch (e) {
        return fail(res, 409, 'Report rejected', (e as Error).message);
      }

      try {
        const appended = await deps.ledger.append(stored.topicId, {
          v: 1,
          type: 'report',
          marketId: stored.id,
          ts: now(),
          position: report.position,
          agentId,
          belief: report.belief,
          rawBelief: report.rawBelief,
        });
        // Feeds the next draw and the stopping roll. The roll itself belongs
        // to the orchestrator, which knows the round is complete (STEP 16).
        stored.rng.update(appended.runningHash);

        return void res.status(201).json({
          position: report.position,
          belief: report.belief,
          rawBelief: report.rawBelief,
          clipped: report.belief[1] !== report.rawBelief[1],
          sequenceNumber: appended.sequenceNumber,
          consensusTimestamp: appended.consensusTimestamp,
        });
      } catch (e) {
        return fail(res, 502, 'Report accepted but could not be written to the ledger', (e as Error).message);
      }
    })();
  });

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
    return void res.json({
      marketId: stored.id,
      topicId: stored.topicId,
      reports: state.reports.map((r) => ({
        position: r.position,
        agentId: r.agentId,
        belief: r.belief,
        rawBelief: r.rawBelief,
        timestamp: r.timestamp,
      })),
      // Anyone can recompute all of this from the topic without trusting us.
      verifyVia: `${stored.topicId}`,
    });
  });

  // ----------------------------------------------------- resolution service
  //
  // Paid, and the shell of it only. STEP 22 fills this in; it is the piece the
  // Hedera track asks for — a real x402-gated service with a platform that
  // consumes it.
  app.post('/resolve', (_req, res) => {
    res.status(501).json({
      error: 'Not implemented yet',
      detail: 'The resolution service is built in STEP 22.',
    });
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
