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
import { bondTinybar, depositTinybar, DEFAULT_RESOLVE_PRICE_TINYBAR } from './pricing.js';
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
}

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
  const facilitator = new HTTPFacilitatorClient({ url: opts.facilitatorUrl });

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
            amount: depositTinybar(params, prior, opts.hbarPerUnit).toString(),
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
      description: 'Buy a market price for a question. Runs the mechanism and returns the answer.',
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
  return paymentMiddlewareFromConfig(routes, facilitator, [
    { network: HEDERA_TESTNET_CAIP2, server: new ExactHederaScheme() },
  ]) as unknown as RequestHandler;
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
