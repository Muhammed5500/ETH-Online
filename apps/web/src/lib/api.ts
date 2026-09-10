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
  readonly timestamp: number;
}

export interface ReportsResponse {
  readonly marketId: string;
  readonly topicId: string;
  readonly reports: readonly ReportView[];
}

export interface AgentView {
  readonly agentId: string;
  readonly accountId: string;
  readonly publicKey: string;
  readonly endpoint?: string;
  readonly ensName?: string;
  readonly sliceIds?: readonly string[];
  readonly registeredAt: number;
}

export interface OpenMarketRequest {
  readonly question: string;
  readonly params?: Partial<MarketParams>;
  readonly prior?: number;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
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
  agents: () => request<{ agents: AgentView[]; count: number }>('/agents'),
  health: () => request<{ ok: boolean; network: string; markets: number; agents: number }>('/health'),

  openMarket: (body: OpenMarketRequest) =>
    request<OpenMarketResponse>('/market', { method: 'POST', body: JSON.stringify(body) }),
};

/** HashScan link for a topic, transaction or account. */
export function hashscan(
  network: string,
  kind: 'topic' | 'transaction' | 'account',
  id: string,
): string {
  return `https://hashscan.io/${network}/${kind}/${id}`;
}
