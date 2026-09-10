/**
 * One error type for everything that can go wrong fetching evidence.
 *
 * WHY THE `kind` FIELD EARNS ITS KEEP. An agent that cannot get its data has
 * to decide between two very different things: back off and try again, or give
 * up and let the orchestrator time it out. Those are opposite actions, and a
 * bare `Error` with a message string forces every caller to guess between them
 * by matching on prose.
 *
 * It matters more here than in an ordinary client, because failing to answer
 * costs an agent its whole bond (STEP 16: a report that never arrives is
 * slashed exactly like silence). An agent that treats a rate limit as fatal
 * throws away money it did not have to lose.
 */

export type GraphErrorKind =
  /** The request never reached the gateway. Retryable. */
  | 'network'
  /** The gateway answered with a status we cannot use. Retryable only for 429/5xx. */
  | 'http'
  /**
   * HTTP 200 with a GraphQL `errors` array.
   *
   * The gateway's auth failure arrives this way — status 200, body
   * `{"errors":[{"message":"auth error: missing authorization header"}]}` —
   * so `res.ok` is true for a request that returned no data at all.
   */
  | 'graphql'
  /** Payment was required and could not be made, or was refused. Never retried. */
  | 'payment'
  /** The answer did not parse, or was not the shape a GraphQL response has. */
  | 'malformed'
  /** We are configured wrongly — missing API key, bad mode, empty subgraph id. */
  | 'config';

export interface GraphErrorDetail {
  readonly kind: GraphErrorKind;
  readonly status?: number;
  readonly subgraphId?: string;
  readonly endpoint?: string;
  /** Messages from a GraphQL `errors` array, when that is what happened. */
  readonly graphqlErrors?: readonly string[];
  /** How many attempts were made in total, including the first. */
  readonly attempts?: number;
  readonly cause?: unknown;
}

export class GraphQueryError extends Error {
  readonly kind: GraphErrorKind;
  readonly status?: number;
  readonly subgraphId?: string;
  readonly endpoint?: string;
  readonly graphqlErrors?: readonly string[];
  readonly attempts?: number;
  override readonly cause?: unknown;

  constructor(message: string, detail: GraphErrorDetail) {
    super(message);
    this.name = 'GraphQueryError';
    this.kind = detail.kind;
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.subgraphId !== undefined) this.subgraphId = detail.subgraphId;
    if (detail.endpoint !== undefined) this.endpoint = detail.endpoint;
    if (detail.graphqlErrors !== undefined) this.graphqlErrors = detail.graphqlErrors;
    if (detail.attempts !== undefined) this.attempts = detail.attempts;
    if (detail.cause !== undefined) this.cause = detail.cause;
  }

  /**
   * Whether waiting and asking again could plausibly work.
   *
   * Note what is NOT retryable: a payment failure. In x402 mode every attempt
   * is a fresh payment, so a client that retries its way through a payment
   * problem pays repeatedly for answers it never gets. Same doctrine as the
   * Hedera retry policy — an unrecognised failure is treated as permanent,
   * because wrongly retrying something that costs money is the expensive
   * mistake and wrongly surfacing a recoverable error is the cheap one.
   */
  get retryable(): boolean {
    if (this.kind === 'network') return true;
    if (this.kind !== 'http') return false;
    return this.status === 429 || (this.status !== undefined && this.status >= 500);
  }
}
