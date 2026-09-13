/**
 * The x402 payment gate.
 *
 * Everything in here was established by SPIKE A (STEP 2) against Hedera
 * testnet. The three things that cost time there are recorded next to the code
 * that depends on them, so they are not rediscovered.
 *
 * PRICES ARE COMPUTED, NOT LISTED. Opening a market costs the deposit bound
 * `b·H_max(prior) + k·R`, which depends on the parameters in the request, and
 * a bond costs whatever that particular market set. Both come from the same
 * functions the route handlers use, so the amount quoted in the 402 and the
 * amount the handler assumes were paid cannot disagree.
 */
import type { RequestHandler } from 'express';
import { paymentMiddlewareFromConfig } from '@x402/express';
import { HTTPFacilitatorClient, type RoutesConfig } from '@x402/core/server';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import { HBAR_ASSET_ID, HEDERA_TESTNET_CAIP2 } from '@x402/hedera';
import type { MarketParams } from '@ethonline/core';
import {
  bondTinybar,
  DEFAULT_PROTOCOL_FEE_TINYBAR,
  DEFAULT_RESOLVE_PRICE_TINYBAR,
  marketPriceTinybar,
} from './pricing.js';
import { logRollback, withPaymentRollback, type RollbackReport } from './payment-rollback.js';
import { resolveParams, resolvePrior } from './app.js';
import type { MarketStore } from './store.js';

export interface PaymentGateOptions {
  /** Hedera account that receives deposits and bonds. */
  readonly treasuryAccountId: string;
  readonly facilitatorUrl: string;
  readonly markets: MarketStore;
  readonly defaultParams: MarketParams;
  readonly hbarPerUnit: number;
  readonly resolvePriceTinybar?: bigint;
  /** Charged to the asker on top of the deposit. Zero unless set. */
  readonly protocolFeeTinybar?: bigint;
  /**
   * Per-request timeout for facilitator calls.
   *
   * The library default is ten seconds, which is tight for a payment rail. It
   * covers the handshake as well as the call, so on a slow or congested link
   * the client gives up before the facilitator has even answered — and every
   * paid route then fails for a reason that has nothing to do with payments.
   * Measured during STEP 17 on a degraded connection: TLS handshake alone took
   * 11-14 seconds, consistently, and no payment could be made at all.
   *
   * Thirty seconds by default, and configurable, so a deployment on a slow
   * link is merely slow rather than broken.
   */
  readonly facilitatorTimeoutMs?: number;
  /**
   * Told whenever a handler's effect had to be undone because the payment for
   * it did not settle. Defaults to a warning on the console — an operator has
   * to see this, since it is money that did not arrive.
   */
  readonly onRollback?: (report: RollbackReport) => void;
}

export const DEFAULT_FACILITATOR_TIMEOUT_MS = 30_000;

/**
 * Anything with a parsed body, if the adapter offers one.
 *
 * `getBody` is optional on the adapter, so every use of it has a fallback.
 * Falling back to the default parameters is safe: the handler recomputes the
 * deposit from the same body and would reject a market it cannot fund.
 */
interface PriceContext {
  readonly path: string;
  readonly adapter: { getBody?(): unknown };
}

/** `/market/mkt-2026-09-10-001/bond` -> `mkt-2026-09-10-001` */
export function marketIdFromPath(path: string): string | undefined {
  const match = /\/market\/([^/?]+)\//.exec(path);
  return match?.[1];
}

export function createPaymentGate(opts: PaymentGateOptions): RequestHandler {
  const facilitator = new HTTPFacilitatorClient({
    url: opts.facilitatorUrl,
    timeoutMs: opts.facilitatorTimeoutMs ?? DEFAULT_FACILITATOR_TIMEOUT_MS,
  });

  const routes: RoutesConfig = {
    'POST /market': {
      description: 'Open a self-resolving market. Price is the deposit bound b·H(prior) + k·R.',
      mimeType: 'application/json',
      accepts: {
        scheme: 'exact',
        network: HEDERA_TESTNET_CAIP2,
        payTo: opts.treasuryAccountId,
        price: (ctx: PriceContext) => {
          const body = ctx.adapter.getBody?.();
          const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
          const params = resolveParams(raw['params'], opts.defaultParams);
          const prior = safePrior(raw['prior']);
          return {
            asset: HBAR_ASSET_ID,
            // deposit + protocol fee. The handler funds the market with the
            // deposit alone; the fee stays with the treasury and never enters
            // the pot settlement pays out of.
            amount: marketPriceTinybar(
              params,
              prior,
              opts.hbarPerUnit,
              opts.protocolFeeTinybar ?? DEFAULT_PROTOCOL_FEE_TINYBAR,
            ).toString(),
          };
        },
      },
    },

    'POST /market/:id/bond': {
      description: 'Post the bond that lets an agent join a market.',
      mimeType: 'application/json',
      accepts: {
        scheme: 'exact',
        network: HEDERA_TESTNET_CAIP2,
        payTo: opts.treasuryAccountId,
        price: (ctx: PriceContext) => {
          // Each market carries its own bond size, so the price is looked up
          // rather than assumed. An unknown market quotes the default and the
          // handler answers 404 — no payment is settled for a market that
          // does not exist.
          const id = marketIdFromPath(ctx.path);
          const stored = id ? opts.markets.get(id) : undefined;
          const amount = stored
            ? stored.bondTinybar
            : bondTinybar(opts.defaultParams, opts.hbarPerUnit);
          return { asset: HBAR_ASSET_ID, amount: amount.toString() };
        },
      },
    },

    'POST /resolve': {
      description:
        'Buy the price a market produced for a question. Charged only when a market has answered ' +
        'it or is running on it; otherwise the request is refused and nothing is settled.',
      mimeType: 'application/json',
      accepts: {
        scheme: 'exact',
        network: HEDERA_TESTNET_CAIP2,
        payTo: opts.treasuryAccountId,
        price: {
          asset: HBAR_ASSET_ID,
          amount: (opts.resolvePriceTinybar ?? DEFAULT_RESOLVE_PRICE_TINYBAR).toString(),
        },
      },
    },
  };

  // The server-side scheme. SPIKE A: this is `@x402/hedera/exact/server`,
  // which is a different export from the client-side scheme of the same name.
  const middleware = paymentMiddlewareFromConfig(routes, facilitator, [
    { network: HEDERA_TESTNET_CAIP2, server: new ExactHederaScheme() },
  ]) as unknown as RequestHandler;

  // The order matters. Outermost is the route filter, so an unpaid route
  // never touches any of this. Inside it sits the rollback watcher, which has
  // to see the FINAL status of the response — including the 402 that
  // `withFacilitatorErrors` and the library itself produce — because that
  // status is the only signal that the money did not move.
  return onlyPaidRoutes(
    withPaymentRollback(withFacilitatorErrors(middleware, opts.facilitatorUrl), {
      onRollback: opts.onRollback ?? logRollback,
    }),
  );
}

/** The three routes that cost money. Everything else never touches the gate. */
const PAID_ROUTES: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\/market\/?$/ },
  { method: 'POST', pattern: /^\/market\/[^/]+\/bond\/?$/ },
  { method: 'POST', pattern: /^\/resolve\/?$/ },
];

export function isPaidRoute(method: string, path: string): boolean {
  const clean = path.split('?')[0] ?? path;
  return PAID_ROUTES.some((r) => r.method === method.toUpperCase() && r.pattern.test(clean));
}

/**
 * Runs the payment gate only for requests that actually cost money.
 *
 * WHY THIS MATTERS BEYOND TIDINESS. Mounted globally, a payment gate that
 * cannot reach its facilitator takes the read endpoints down with it — and
 * those are exactly the ones that should survive. A market already written to
 * HCS can still be verified by anyone; there is no reason an outage in the
 * payment rail should stop that. Nobody can open a NEW market, which is
 * correct, and everything already on the record stays readable.
 */
export function onlyPaidRoutes(middleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (!isPaidRoute(req.method, req.path)) return next();
    return middleware(req, res, next);
  };
}

/**
 * Turns "the payment infrastructure is unreachable" into a 503 that says so.
 *
 * Found the hard way during STEP 17: with the facilitator unreachable, the
 * middleware throws while loading its supported payment kinds and Express
 * answers a bare `500 Internal Server Error`. From the caller's side that is
 * indistinguishable from a malformed request — and for a paid API the
 * difference matters a great deal. One means "fix your request", the other
 * means "wait and try again"; a client that cannot tell them apart will retry
 * the wrong one.
 *
 * 503 is the honest code: the service is temporarily unable to handle the
 * request, and the fault is not the caller's.
 */
export function withFacilitatorErrors(
  middleware: RequestHandler,
  facilitatorUrl: string,
): RequestHandler {
  return (req, res, next) => {
    const fail = (e: unknown): void => {
      if (res.headersSent) return;
      const message = e instanceof Error ? e.message : String(e);
      res.status(503).json({
        error: 'Payment infrastructure unavailable',
        detail:
          `Could not reach the x402 facilitator at ${facilitatorUrl}. ` +
          `This is not a problem with your request — retry shortly.`,
        cause: message.slice(0, 200),
      });
    };

    // Both shapes have to be caught. The x402 middleware is async, so it
    // rejects; but a middleware that throws synchronously would sail straight
    // past a promise-only guard and Express would answer 500 after all.
    try {
      const result = middleware(req, res, next) as unknown;
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void (result as Promise<unknown>).catch(fail);
      }
    } catch (e) {
      fail(e);
    }
  };
}

function safePrior(raw: unknown): ReturnType<typeof resolvePrior> {
  try {
    return resolvePrior(raw);
  } catch {
    return resolvePrior(undefined);
  }
}

/**
 * Client-side spend controls for anything of ours that PAYS (STEP 20's agents,
 * and the demo scripts).
 *
 * SPIKE A trap: the default controls allow only "default assets", and HBAR is
 * not one, so an unconfigured client rejects every Hedera payment with
 * "All payment requirements were rejected by spendControls". The fix is not to
 * disable the controls but to allow HBAR with a ceiling — which is a feature
 * worth having once agents are paying for Graph queries on their own.
 */
export function hederaSpendControls(maxAmountPerPayment: bigint) {
  return {
    allowedAssets: [
      {
        network: HEDERA_TESTNET_CAIP2,
        asset: HBAR_ASSET_ID,
        maxAmountPerPayment: maxAmountPerPayment.toString(),
      },
    ],
  };
}

/**
 * The settlement header's name.
 *
 * SPIKE A trap, and the one that cost the most: it is `payment-response`, NOT
 * `x-payment-response`. Reading the wrong name returns nothing and looks
 * exactly like a failed payment, while the payment has in fact gone through.
 */
export const SETTLEMENT_HEADER = 'payment-response';

export interface PayWithRetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  /**
   * Asks the SERVER whether the request already took effect.
   *
   * This is what makes retrying safe. A 402 usually means the payment was
   * never settled, but "the facilitator settled and the response was lost"
   * looks identical from here — and retrying that would pay twice. So the
   * decision to retry is based on server state, not on the payment result.
   */
  readonly alreadyDone?: () => Promise<boolean>;
  readonly onRetry?: (attempt: number, delayMs: number, status: number) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Sends a paid request, retrying a 402 with backoff.
 *
 * WHY THIS EXISTS. Twenty agents bonding one after another is the normal shape
 * of a market opening, and in practice a run of rapid payments does not all
 * succeed first time: during STEP 16 the ninth bond in a row came back 402
 * while the same agent paid fine on its own a moment later. Nothing was wrong
 * with the account — the balance had not moved — so the payment simply had not
 * been settled.
 *
 * Without a retry the demo is one transient facilitator hiccup away from a
 * market that cannot reach its minimum pool.
 */
export async function payWithRetry(
  doRequest: () => Promise<Response>,
  opts: PayWithRetryOptions = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let last: Response | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await doRequest();
    // 402 means the payment did not settle; 503 is our own "the payment rail
    // is temporarily unreachable, retry shortly". Both are worth another go.
    // Anything else is a real answer, success or otherwise.
    if (res.status !== 402 && res.status !== 503) return res;
    last = res;

    if (opts.alreadyDone && (await opts.alreadyDone())) return res;
    if (attempt === attempts) break;

    const delay = baseDelayMs * 2 ** (attempt - 1);
    opts.onRetry?.(attempt, delay, res.status);
    await sleep(delay);
  }
  return last!;
}

/**
 * Opens a connection to the facilitator before the server takes traffic.
 *
 * WHY. The x402 resource server loads its supported payment kinds on first
 * use, with a ten-second timeout. In a cold process the very first outbound
 * HTTPS connection is the slowest one it will ever make — DNS, TLS, the lot —
 * and it can blow through that budget. The cost then lands on whoever happens
 * to send the first paid request, which is exactly the wrong person to charge
 * for it. Measured during STEP 17: first connection 14s, every one after it
 * under half a second.
 *
 * So we pay the cold-start ourselves, at boot, where it is free. It also turns
 * "the facilitator is down" into something the operator learns at startup
 * rather than from a customer.
 *
 * Never throws: an unreachable facilitator is worth reporting, not worth
 * refusing to start over. The read endpoints work without it.
 */
export async function warmUpFacilitator(
  facilitatorUrl: string,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${facilitatorUrl}/supported`, { signal: controller.signal });
    return { ok: res.ok, ms: Date.now() - started };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}
