/**
 * The Graph Gateway client — where every agent's evidence comes from.
 *
 * This is the input side of the mechanism. An agent pays for its data, reasons
 * over it, and reports a probability; that report decides who gets paid. So a
 * query that silently returns nothing is not a missing feature, it is a market
 * scored on evidence that was never there.
 *
 * TWO MODES, AND WHY BOTH EXIST.
 *
 *   x402    No API key. The gateway answers 402, the client pays USDC on Base,
 *           and the query goes through. This is the story the track actually
 *           asks for: an agent that buys its own inputs and sells its output,
 *           with no account, no session and no human in the loop.
 *
 *   apikey  A Studio key in an `Authorization` header. Development mode.
 *
 * The fallback is not timidity. STEP 3 established that The Graph's TESTNET
 * gateway is not deployed — `testnet.gateway.thegraph.com` still has no address
 * record as of 2026-09-10 — so x402 mode means Base MAINNET and real money at
 * $0.01 a query. Developing against that would mean paying to run a test suite.
 * The demo runs on x402; the fifty iterations before it do not.
 *
 * THE TRAP THAT SHAPED THE ERROR HANDLING. Observed live on 2026-09-10:
 *
 *   POST /api/subgraphs/id/<id>   with no Authorization header
 *   -> HTTP 200
 *      {"errors":[{"message":"auth error: missing authorization header"}]}
 *
 * An auth failure with status 200. Any client that trusts `res.ok` and reads
 * `body.data` gets `undefined` and hands an agent an empty evidence set. That
 * is why a GraphQL `errors` array is a thrown error here and never a warning.
 */
import {
  ATTESTATION_HEADER,
  PAYMENT_SETTLEMENT_HEADER,
  amountToDecimal,
  decodeSettlement,
  lookupAsset,
  type X402Settlement,
} from './x402.js';
import { GraphQueryError, type GraphErrorKind } from './errors.js';

export type GatewayMode = 'x402' | 'apikey';

/** Just enough of `fetch` to be injectable. Tests pass a fake; x402 mode passes a wrapper. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_GATEWAY_URL = 'https://gateway.thegraph.com';

/**
 * The gateway's own published price, used when no receipt says otherwise.
 *
 * Confirmed live: the 402 challenge quotes `"amount": "10000"` of 6-decimal
 * USDC, which is one cent.
 */
export const DEFAULT_LIST_PRICE_USD = 0.01;

/** Per-attempt ceiling. An x402 attempt includes signing and the facilitator round trip. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface GatewayRetryOptions {
  /** Total attempts including the first. Default 3. */
  readonly attempts?: number;
  /** First backoff delay in ms; doubles each time. Default 500. */
  readonly baseDelayMs?: number;
  /** Ceiling on one backoff delay. Default 8000. */
  readonly maxDelayMs?: number;
  readonly onRetry?: (attempt: number, delayMs: number, err: GraphQueryError) => void;
  /** Injected in tests so the suite never actually waits. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface GatewayConfig {
  readonly mode: GatewayMode;
  /** Defaults to the production gateway. */
  readonly baseUrl?: string;
  /** Required in `apikey` mode, ignored in `x402` mode. */
  readonly apiKey?: string;
  /**
   * The fetch that performs the request.
   *
   * In `x402` mode this must be a payment-wrapping fetch — see
   * `createX402Fetch`. Injected rather than constructed here so the whole
   * client is testable with no signer, no viem and no network, which is what
   * keeps `pnpm test` offline and in the seconds.
   */
  readonly fetchImpl?: FetchLike;
  /** Fallback price when a query produced no settlement receipt. */
  readonly listPriceUsd?: number;
  readonly timeoutMs?: number;
  readonly retry?: GatewayRetryOptions;
  readonly now?: () => number;
}

export interface QueryCost {
  /** Absent when the asset's decimals are unknown — see `KNOWN_ASSETS`. */
  readonly usd?: number;
  readonly source: 'settlement' | 'list-price';
  /** The figure came from a price list, not from a receipt. */
  readonly estimated: boolean;
  /** A settlement receipt proves THIS query was paid for. */
  readonly settled: boolean;
  readonly network?: string;
  readonly asset?: string;
  readonly amountRaw?: string;
  readonly transaction?: string;
}

export interface QueryResult<T> {
  readonly data: T;
  /** Transaction hash from the settlement receipt, when there was one. */
  readonly paymentProof?: string;
  /** Convenience mirror of `cost.usd`, as the roadmap specifies. */
  readonly costUsd?: number;
  readonly cost: QueryCost;
  /** Which indexer served this, per the gateway's own attestation header. */
  readonly attestation?: string;
  readonly subgraphId: string;
  readonly attempts: number;
  readonly durationMs: number;
}

export interface SpendRecord {
  readonly subgraphId: string;
  readonly at: number;
  readonly usd?: number;
  readonly settled: boolean;
  readonly estimated: boolean;
  readonly transaction?: string;
  /** False when the query was paid for but still failed. Those exist. */
  readonly ok: boolean;
}

export interface SpendSummary {
  readonly queries: number;
  /** Queries with a settlement receipt. */
  readonly settledQueries: number;
  readonly totalUsd: number;
  /** The part of `totalUsd` that is a receipt rather than an estimate. */
  readonly settledUsd: number;
  readonly estimatedUsd: number;
}

interface GraphQLBody<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

/** A deployment id is an IPFS v0 CID and always starts `Qm`. Subgraph ids do not. */
export function isDeploymentId(id: string): boolean {
  return /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(id);
}

/**
 * Rejects an id that could escape its path segment.
 *
 * The id is interpolated straight into a URL, and these ids arrive from
 * configuration and, later, from subgraph discovery — not all of it ours.
 */
function assertSafeId(id: string): void {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new GraphQueryError('Subgraph id is empty.', { kind: 'config' });
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new GraphQueryError(
      `Subgraph id contains characters that are not allowed in a path segment: ${JSON.stringify(id)}`,
      { kind: 'config', subgraphId: id },
    );
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait when the gateway tells us.
 *
 * `Retry-After` is either a number of seconds or an HTTP date. Both forms show
 * up in the wild, so both are read; anything else falls back to our backoff.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

export class GraphGateway {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly listPriceUsd: number;
  private readonly timeoutMs: number;
  private readonly retry: Required<Omit<GatewayRetryOptions, 'onRetry'>> &
    Pick<GatewayRetryOptions, 'onRetry'>;
  private readonly now: () => number;
  private readonly records: SpendRecord[] = [];

  readonly mode: GatewayMode;

  constructor(private readonly config: GatewayConfig) {
    if (config.mode !== 'x402' && config.mode !== 'apikey') {
      throw new GraphQueryError(
        `Gateway mode must be "x402" or "apikey", got: ${JSON.stringify(config.mode)}`,
        { kind: 'config' },
      );
    }
    if (config.mode === 'apikey' && !config.apiKey) {
      throw new GraphQueryError(
        'apikey mode needs GRAPH_API_KEY. Without it the gateway answers HTTP 200 with an ' +
          'auth error in the GraphQL body, which looks like an empty result rather than a ' +
          'configuration mistake.',
        { kind: 'config' },
      );
    }
    if (config.mode === 'x402' && !config.fetchImpl) {
      throw new GraphQueryError(
        'x402 mode needs a payment-wrapping fetch. Build one with createX402Fetch() and pass ' +
          'it as fetchImpl — a plain fetch would just collect 402s.',
        { kind: 'config' },
      );
    }

    this.mode = config.mode;
    this.baseUrl = (config.baseUrl ?? DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    this.listPriceUsd = config.listPriceUsd ?? DEFAULT_LIST_PRICE_USD;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = config.now ?? (() => Date.now());
    this.retry = {
      attempts: config.retry?.attempts ?? 3,
      baseDelayMs: config.retry?.baseDelayMs ?? 500,
      maxDelayMs: config.retry?.maxDelayMs ?? 8000,
      sleep: config.retry?.sleep ?? defaultSleep,
      ...(config.retry?.onRetry ? { onRetry: config.retry.onRetry } : {}),
    };
    if (!Number.isInteger(this.retry.attempts) || this.retry.attempts < 1) {
      throw new GraphQueryError(
        `retry.attempts must be a positive integer, got: ${this.retry.attempts}`,
        { kind: 'config' },
      );
    }
  }

  /** The URL a query for this id goes to. Public so a step log can quote it. */
  endpointFor(id: string): string {
    assertSafeId(id);
    const kind = isDeploymentId(id) ? 'deployments' : 'subgraphs';
    const prefix = this.mode === 'x402' ? '/api/x402' : '/api';
    return `${this.baseUrl}${prefix}/${kind}/id/${id}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.mode === 'apikey' && this.config.apiKey) {
      h['authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return h;
  }

  /**
   * Sends one GraphQL query, paying for it if that is what the mode does.
   *
   * Retries only what is genuinely worth retrying: a transport failure, a 429,
   * or a 5xx. Never a payment failure — in x402 mode every attempt is a fresh
   * payment, so retrying through one pays repeatedly for answers that never
   * arrive.
   */
  async query<T = unknown>(
    subgraphId: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<QueryResult<T>> {
    assertSafeId(subgraphId);
    if (typeof query !== 'string' || query.trim() === '') {
      throw new GraphQueryError('Query string is empty.', { kind: 'config', subgraphId });
    }

    const endpoint = this.endpointFor(subgraphId);
    const body = JSON.stringify(variables ? { query, variables } : { query });
    const started = this.now();

    let lastError: GraphQueryError | undefined;

    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      try {
        const result = await this.attempt<T>(endpoint, subgraphId, body, attempt, started);
        return result;
      } catch (e) {
        const err =
          e instanceof GraphQueryError
            ? e
            : new GraphQueryError(`Query failed: ${(e as Error).message}`, {
                kind: 'network',
                subgraphId,
                endpoint,
                attempts: attempt,
                cause: e,
              });
        lastError = err;

        if (attempt === this.retry.attempts || !err.retryable) throw err;

        const advertised = err.status === 429 ? this.retryAfterMs : undefined;
        const backoff = Math.min(
          this.retry.maxDelayMs,
          this.retry.baseDelayMs * 2 ** (attempt - 1),
        );
        const delay = advertised ?? backoff;
        this.retry.onRetry?.(attempt, delay, err);
        await this.retry.sleep(delay);
      }
    }

    throw lastError;
  }

  /** Set by the last 429 so the retry loop can honour the gateway's own pacing. */
  private retryAfterMs: number | undefined;

  private async attempt<T>(
    endpoint: string,
    subgraphId: string,
    body: string,
    attempt: number,
    started: number,
  ): Promise<QueryResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: this.headers(),
        body,
        signal: controller.signal,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const aborted = controller.signal.aborted;
      throw new GraphQueryError(
        aborted
          ? `Query timed out after ${this.timeoutMs} ms.`
          : `Could not reach the gateway: ${message}`,
        { kind: 'network', subgraphId, endpoint, attempts: attempt, cause: e },
      );
    } finally {
      clearTimeout(timer);
    }

    // Read the receipt BEFORE deciding whether the query succeeded. A query
    // can be paid for and still fail, and that money is gone either way —
    // leaving it out of the accounting would understate what evidence costs.
    const settlement = readSettlement(res);
    const cost = this.costFrom(settlement);
    const attestation = res.headers.get(ATTESTATION_HEADER) ?? undefined;

    const record = (ok: boolean): void => {
      this.records.push({
        subgraphId,
        at: this.now(),
        ...(cost.usd !== undefined ? { usd: cost.usd } : {}),
        settled: cost.settled,
        estimated: cost.estimated,
        ...(cost.transaction ? { transaction: cost.transaction } : {}),
        ok,
      });
    };

    if (!res.ok) {
      if (res.status === 429) {
        this.retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.now());
      }
      if (settlement) record(false);
      throw await httpError(res, subgraphId, endpoint, attempt);
    }

    let parsed: GraphQLBody<T>;
    const text = await res.text();
    try {
      parsed = JSON.parse(text) as GraphQLBody<T>;
    } catch (e) {
      if (settlement) record(false);
      throw new GraphQueryError(
        `Gateway answered ${res.status} with a body that is not JSON: ${truncate(text)}`,
        { kind: 'malformed', status: res.status, subgraphId, endpoint, attempts: attempt, cause: e },
      );
    }

    const messages = (parsed.errors ?? [])
      .map((e) => (typeof e?.message === 'string' ? e.message : JSON.stringify(e)))
      .filter((m) => m.length > 0);

    if (messages.length > 0) {
      if (settlement) record(false);
      throw new GraphQueryError(graphqlMessage(messages, this.mode), {
        kind: 'graphql',
        status: res.status,
        subgraphId,
        endpoint,
        graphqlErrors: messages,
        attempts: attempt,
      });
    }

    if (parsed.data === undefined || parsed.data === null) {
      if (settlement) record(false);
      throw new GraphQueryError(
        `Gateway answered ${res.status} with neither "data" nor "errors": ${truncate(text)}`,
        { kind: 'malformed', status: res.status, subgraphId, endpoint, attempts: attempt },
      );
    }

    record(true);

    return {
      data: parsed.data,
      ...(cost.transaction ? { paymentProof: cost.transaction } : {}),
      ...(cost.usd !== undefined ? { costUsd: cost.usd } : {}),
      cost,
      ...(attestation ? { attestation } : {}),
      subgraphId,
      attempts: attempt,
      durationMs: this.now() - started,
    };
  }

  /**
   * What this query cost.
   *
   * A settlement receipt is the only proof money moved, so it drives `settled`.
   * The dollar figure may still have to come from the price list when the
   * receipt does not carry an amount — that combination is reported as settled
   * AND estimated, which is exactly what it is.
   */
  private costFrom(settlement: X402Settlement | undefined): QueryCost {
    if (!settlement) {
      return {
        usd: this.listPriceUsd,
        source: 'list-price',
        estimated: true,
        settled: false,
      };
    }

    const raw = settlement.raw;
    const amount = typeof raw['amount'] === 'string' ? raw['amount'] : undefined;
    const asset = typeof raw['asset'] === 'string' ? raw['asset'] : undefined;
    const network = settlement.network ?? (typeof raw['network'] === 'string' ? raw['network'] : undefined);
    const known = network && asset ? lookupAsset(network, asset) : undefined;

    if (amount && known) {
      return {
        usd: amountToDecimal(amount, known.decimals),
        source: 'settlement',
        estimated: false,
        settled: true,
        network,
        asset,
        amountRaw: amount,
        ...(settlement.transaction ? { transaction: settlement.transaction } : {}),
      };
    }

    return {
      usd: this.listPriceUsd,
      source: 'list-price',
      estimated: true,
      settled: true,
      ...(network ? { network } : {}),
      ...(asset ? { asset } : {}),
      ...(amount ? { amountRaw: amount } : {}),
      ...(settlement.transaction ? { transaction: settlement.transaction } : {}),
    };
  }

  /** Every query this client has paid for, oldest first. */
  get history(): readonly SpendRecord[] {
    return this.records;
  }

  /** What the evidence has cost so far. Shown per agent in the demo. */
  get spend(): SpendSummary {
    let totalUsd = 0;
    let settledUsd = 0;
    let estimatedUsd = 0;
    let settledQueries = 0;
    for (const r of this.records) {
      const usd = r.usd ?? 0;
      totalUsd += usd;
      if (r.settled) settledQueries++;
      if (r.estimated) estimatedUsd += usd;
      else settledUsd += usd;
    }
    return {
      queries: this.records.length,
      settledQueries,
      totalUsd: round6(totalUsd),
      settledUsd: round6(settledUsd),
      estimatedUsd: round6(estimatedUsd),
    };
  }
}

function readSettlement(res: Response): X402Settlement | undefined {
  const header = res.headers.get(PAYMENT_SETTLEMENT_HEADER);
  if (!header) return undefined;
  try {
    return decodeSettlement(header);
  } catch {
    // A receipt we cannot parse still proves a payment was made; losing that
    // fact would understate the spend. Keep the evidence, drop the detail.
    return { raw: {} };
  }
}

/**
 * Turns a failing status into an error that says what to do about it.
 *
 * 402 is called out separately because in x402 mode it means the payment layer
 * did not do its job — either the wrapper was not installed, or the wallet
 * could not pay. Both are configuration problems dressed as a network answer,
 * and neither is fixed by asking again.
 */
async function httpError(
  res: Response,
  subgraphId: string,
  endpoint: string,
  attempt: number,
): Promise<GraphQueryError> {
  const body = truncate(await res.text().catch(() => ''));
  const kind: GraphErrorKind = res.status === 402 ? 'payment' : 'http';

  const detail =
    res.status === 402
      ? 'The gateway is asking for payment and none was made. In x402 mode the fetch must be ' +
        'the payment-wrapping one; check the wallet has USDC on Base. Not retried, because ' +
        'every attempt would be a fresh payment.'
      : res.status === 429
        ? 'Rate limited by the gateway.'
        : body || res.statusText;

  return new GraphQueryError(`Gateway answered ${res.status}: ${detail}`, {
    kind,
    status: res.status,
    subgraphId,
    endpoint,
    attempts: attempt,
  });
}

/** Adds the one hint that turns a confusing GraphQL error into an obvious one. */
function graphqlMessage(messages: readonly string[], mode: GatewayMode): string {
  const joined = messages.join('; ');
  if (/auth error/i.test(joined)) {
    return (
      `Gateway rejected the query with HTTP 200 and an auth error: ${joined}. ` +
      (mode === 'apikey'
        ? 'GRAPH_API_KEY is missing, wrong, or out of quota.'
        : 'In x402 mode this means the request reached the keyed endpoint instead of the ' +
          'x402 one — check baseUrl and mode.')
    );
  }
  return `Gateway returned GraphQL errors: ${joined}`;
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
