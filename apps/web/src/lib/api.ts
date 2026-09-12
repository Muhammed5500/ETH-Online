/**
 * The API client.
 *
 * WHERE THE API LIVES, AND WHY THE PAGES ARE NAMED THE WAY THEY ARE.
 *
 * In production the Express app serves this bundle, so the API and the pages
 * share an origin and the API sits at the root: `GET /markets`,
 * `GET /market/:id`, `GET /agents`. That is a genuine collision with the
 * obvious page names — a browser navigating to `/market/mkt-001` would be
 * answered by the API with JSON instead of the page.
 *
 * The tidy fix is to namespace the API under `/api`, and it was rejected:
 * those exact paths are what the x402 payment gate is configured against and
 * what STEP 17 verified end to end on testnet. Moving them to make the URLs
 * prettier means re-verifying the payment rail, which is the one part of this
 * system it is least sensible to disturb.
 *
 * So the PAGES took the different names instead — `/m/:id`, `/directory` — and
 * the API kept the ones it already had.
 *
 * In dev, Vite proxies `/api/*` to the demo server with the prefix stripped,
 * so the same relative paths work in both modes with only the base changing.
 */
import type { Belief, MarketParams } from '@ethonline/core';

export const API_BASE = import.meta.env.DEV ? '/api' : '';

export type MarketStatus = 'bonding' | 'running' | 'closed' | 'settled' | 'cancelled';
export type ClosedReason = 'stopping-rule' | 'pool-exhausted';

/** Exactly what `publicMarketView` returns. Deliberately no more. */
export interface MarketView {
  readonly marketId: string;
  readonly question: string;
  readonly status: MarketStatus;
  readonly topicId: string;
  readonly params: MarketParams;
  readonly prior: Belief;
  readonly currentPrice: Belief;
  readonly reportCount: number;
  readonly bondedCount: number;
  readonly closedReason?: ClosedReason;
  readonly reference?: Belief;
  /** Tinybar, as a string: it is a uint64 and would lose precision as a number. */
  readonly depositTinybar: string;
  readonly bondTinybar: string;
  readonly createdAt: number;
  readonly bondingClosesAt: number;
}

export interface ReportView {
  readonly position: number;
  readonly agentId: string;
  readonly belief: Belief;
  readonly rawBelief: Belief;
  /** Where the price stood before this agent moved it. */
  readonly previousBelief: Belief;
  /** The protocol had to pull the report back inside what the bond carries. */
  readonly clipped: boolean;
  readonly timestamp: number;
  /** The agent's own account of itself. Not signed, not scored. */
  readonly reasoning?: string;
  readonly sliceIds?: readonly string[];
  readonly evidenceCostUsd?: number;
  readonly evidenceDigest?: string;
}

export interface ReportsResponse {
  readonly marketId: string;
  readonly topicId: string;
  readonly prior: Belief;
  readonly reports: readonly ReportView[];
}

/** One value pulled out of a running hash, with everything needed to recheck it. */
export interface RandomnessDrawView {
  readonly label: string;
  readonly purpose: 'stop' | 'draw';
  readonly position: number;
  readonly runningHash: string;
  readonly value: number;
  readonly alpha?: number;
  readonly stopped?: boolean;
}

export interface RandomnessResponse {
  readonly marketId: string;
  readonly topicId: string;
  readonly alpha: number;
  readonly draws: readonly RandomnessDrawView[];
  /** A draw exists that is deliberately not published: an agent has not reported yet. */
  readonly pendingHidden: boolean;
  readonly howToVerify: string;
}

export interface PayoutView {
  readonly agentId: string;
  readonly position: number;
  readonly kind: 'scored' | 'flat-fee';
  /** In mechanism units. Negative for an agent that moved the price the wrong way. */
  readonly amount: number;
  /** The unscaled S_CEM value. Absent for a flat fee, which has no score behind it. */
  readonly scoreRaw?: number;
}

export interface TransferView {
  readonly beneficiary: string;
  readonly accountId: string;
  readonly kind: 'scored' | 'flat-fee' | 'not-drawn' | 'timed-out' | 'asker';
  readonly amountTinybar: string;
  readonly bondReturnedTinybar: string;
  readonly payoutTinybar: string;
  readonly chunkIndex?: number;
  readonly chunkState?: 'pending' | 'sent' | 'unknown';
  readonly transactionId?: string;
}

/** The §6.2 claim, as two numbers a reader can compare. */
export interface BoundView {
  readonly maxScoringUnits: number;
  readonly actualScoringUnits: number;
  readonly flatFeeUnits: number;
  readonly requiredDepositUnits: number;
  readonly withinBound: boolean;
  readonly maxScoringTinybar: string;
}

export interface SettlementView {
  readonly marketId: string;
  readonly status: 'not-settled' | 'in-progress' | 'complete' | 'blocked';
  readonly marketStatus: MarketStatus;
  readonly topicId?: string;
  readonly reference?: Belief;
  readonly payouts?: readonly PayoutView[];
  readonly totals?: {
    readonly deposit: number;
    readonly totalBonds: number;
    readonly scoreTotal: number;
    readonly bondsReturned: number;
    readonly timeoutSlash: number;
    readonly scoreSlash: number;
    readonly totalToAgents: number;
    readonly askerRefund: number;
  };
  readonly bound?: BoundView;
  readonly transfers?: readonly TransferView[];
  readonly accounting?: {
    readonly inTinybar: string;
    readonly outTinybar: string;
    readonly paidToAgentsTinybar: string;
    readonly askerRefundTinybar: string;
    readonly slashedTinybar: string;
    readonly balances: boolean;
  };
  readonly progress?: {
    readonly chunks: number;
    readonly sent: number;
    readonly pending: number;
    readonly unknown: number;
    readonly blocked: boolean;
  };
}

/** What an agent has done, counted from the markets rather than claimed. */
export interface AgentRecord {
  readonly bonded: number;
  readonly reported: number;
  readonly reference: number;
  readonly timedOut: number;
  readonly flatFee: number;
  /** Mechanism units, summed over settled markets. May be negative. */
  readonly net: number;
  readonly settledMarkets: number;
}

export interface AgentView {
  readonly agentId: string;
  readonly accountId: string;
  readonly publicKey: string;
  readonly endpoint?: string;
  readonly ensName?: string;
  readonly sliceIds?: readonly string[];
  readonly registeredAt: number;
  /** Absent on an older server; the directory renders identity alone then. */
  readonly record?: AgentRecord;
}

export interface OpenMarketRequest {
  readonly question: string;
  readonly params?: Partial<MarketParams>;
  readonly prior?: number;
  /**
   * Where the unspent deposit comes back to.
   *
   * The server cannot work this out for itself: the x402 gate settles after
   * the handler has run, so the payer's account is not visible at the moment
   * the market is created. The page knows it — it is the connected wallet —
   * so it says so. Nothing is lost by a caller that omits it except its own
   * refund, which the server then refuses to send anywhere.
   */
  readonly askerAccountId?: string;
}

export interface OpenMarketResponse {
  readonly marketId: string;
  readonly topicId: string;
  readonly bondingClosesAt: number;
  readonly params: MarketParams;
  readonly depositTinybar: string;
  readonly bondTinybar: string;
}

/**
 * An API error the UI can act on.
 *
 * `402` and `503` are the two that need different words on screen from
 * everything else: one means "pay for it", the other means "the payment rail
 * is down, this is not your fault" — a distinction the API went out of its way
 * to make (STEP 17) and that would be wasted if the client flattened it.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isPaymentRequired(): boolean {
    return this.status === 402;
  }

  get isUpstreamDown(): boolean {
    return this.status === 503;
  }
}

/**
 * The `fetch` a request goes through.
 *
 * Injectable for exactly one reason: paying. A wallet-backed x402 client is a
 * wrapped `fetch` that answers a 402 by signing and retrying, so the only way
 * to pay for a route is to hand that wrapper to the call. Reads stay on the
 * plain global.
 */
export type FetchLike = typeof fetch;

async function request<T>(
  path: string,
  init?: RequestInit,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch (e) {
    throw new ApiError('Could not reach the API.', 0, (e as Error).message);
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(`The API answered ${res.status} with something that is not JSON.`, res.status, text.slice(0, 200));
  }

  if (!res.ok) {
    const o = body as { error?: string; detail?: string };
    throw new ApiError(o.error ?? `Request failed with ${res.status}.`, res.status, o.detail);
  }
  return body as T;
}

export const api = {
  markets: () => request<{ markets: MarketView[]; count: number }>('/markets'),
  market: (id: string) => request<MarketView>(`/market/${encodeURIComponent(id)}`),
  reports: (id: string) => request<ReportsResponse>(`/market/${encodeURIComponent(id)}/reports`),
  randomness: (id: string) =>
    request<RandomnessResponse>(`/market/${encodeURIComponent(id)}/randomness`),
  settlement: (id: string) =>
    request<SettlementView>(`/market/${encodeURIComponent(id)}/settlement`),
  agents: () => request<{ agents: AgentView[]; count: number }>('/agents'),
  health: () => request<{ ok: boolean; network: string; markets: number; agents: number }>('/health'),

  /**
   * The one paid call in this client.
   *
   * Pass the wallet's paying fetch to settle the 402; omit it and the request
   * goes unpaid, which the demo server accepts and the real one refuses.
   */
  openMarket: (body: OpenMarketRequest, fetchImpl?: FetchLike) =>
    request<OpenMarketResponse>(
      '/market',
      { method: 'POST', body: JSON.stringify(body) },
      fetchImpl,
    ),
};

/** HashScan link for a topic, transaction or account. */
export function hashscan(
  network: string,
  kind: 'topic' | 'transaction' | 'account',
  id: string,
): string {
  return `https://hashscan.io/${network}/${kind}/${id}`;
}
