/**
 * Gateway client tests.
 *
 * Two things are being defended here, and neither is "the happy path works".
 *
 *   An empty answer must never look like a successful one. The gateway
 *   returns HTTP 200 with a GraphQL auth error when the API key is missing —
 *   observed live — so `res.ok` is not evidence that any data arrived. An
 *   agent handed an empty evidence set still reports a probability, and that
 *   report still decides who gets paid.
 *
 *   A payment must never be retried. In x402 mode every attempt is a fresh
 *   cent, so a retry loop that treats 402 as transient pays over and over for
 *   answers it never gets.
 */
import { describe, expect, it, vi } from 'vitest';
import { GraphGateway, parseRetryAfter, isDeploymentId, type FetchLike } from '../src/gateway.js';
import { GraphQueryError } from '../src/errors.js';

const SUBGRAPH = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';
const DEPLOYMENT = 'QmVJvvRRJfKHnQEqz9ZBQZKPYqcNJcbLbNTeMcPdgQMPTX';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const QUERY = '{ _meta { block { number } } }';

const noSleep = async (): Promise<void> => {};

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64');
}

/** A fetch that answers with the given responses in order. */
function scriptedFetch(...responses: Array<Response | Error>): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next instanceof Error) throw next;
    // Clone so a repeated script entry can be consumed more than once.
    return next!.clone();
  };
  return { fetchImpl, calls };
}

function ok(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function apikeyGateway(fetchImpl: FetchLike, overrides = {}): GraphGateway {
  return new GraphGateway({
    mode: 'apikey',
    apiKey: 'test-key',
    fetchImpl,
    retry: { sleep: noSleep },
    ...overrides,
  });
}

describe('construction', () => {
  it('refuses apikey mode with no key', () => {
    // Without this the gateway answers 200 with an auth error in the body,
    // which reads like an empty result rather than a misconfiguration.
    expect(() => new GraphGateway({ mode: 'apikey' })).toThrow(/GRAPH_API_KEY/);
  });

  it('refuses x402 mode with a plain fetch', () => {
    // A plain fetch would just collect 402s and never pay.
    expect(() => new GraphGateway({ mode: 'x402' })).toThrow(/payment-wrapping fetch/);
  });

  it('refuses an unknown mode', () => {
    expect(() => new GraphGateway({ mode: 'freebie' as never })).toThrow(/x402.*apikey/);
  });

  it('refuses a nonsense retry count', () => {
    expect(() =>
      new GraphGateway({ mode: 'apikey', apiKey: 'k', retry: { attempts: 0 } }),
    ).toThrow(/attempts/);
  });
});

describe('endpoints', () => {
  it('routes a subgraph id to the keyed path in apikey mode', () => {
    const g = apikeyGateway(scriptedFetch(ok({})).fetchImpl);
    expect(g.endpointFor(SUBGRAPH)).toBe(
      `https://gateway.thegraph.com/api/subgraphs/id/${SUBGRAPH}`,
    );
  });

  it('routes to the x402 path in x402 mode', () => {
    const g = new GraphGateway({ mode: 'x402', fetchImpl: scriptedFetch(ok({})).fetchImpl });
    expect(g.endpointFor(SUBGRAPH)).toBe(
      `https://gateway.thegraph.com/api/x402/subgraphs/id/${SUBGRAPH}`,
    );
  });

  it('recognises a deployment id and uses the deployments path', () => {
    expect(isDeploymentId(DEPLOYMENT)).toBe(true);
    expect(isDeploymentId(SUBGRAPH)).toBe(false);
    const g = apikeyGateway(scriptedFetch(ok({})).fetchImpl);
    expect(g.endpointFor(DEPLOYMENT)).toBe(
      `https://gateway.thegraph.com/api/deployments/id/${DEPLOYMENT}`,
    );
  });

  it('trims a trailing slash off the base url', () => {
    const g = apikeyGateway(scriptedFetch(ok({})).fetchImpl, {
      baseUrl: 'https://example.test/',
    });
    expect(g.endpointFor(SUBGRAPH)).toBe(`https://example.test/api/subgraphs/id/${SUBGRAPH}`);
  });

  it('refuses an id that could escape its path segment', async () => {
    const g = apikeyGateway(scriptedFetch(ok({})).fetchImpl);
    expect(() => g.endpointFor('../../admin')).toThrow(/path segment/);
    await expect(g.query('a/b', QUERY)).rejects.toThrow(/path segment/);
    await expect(g.query('', QUERY)).rejects.toThrow(/empty/);
  });
});

describe('a successful query', () => {
  it('posts the query and returns the data', async () => {
    const { fetchImpl, calls } = scriptedFetch(ok({ data: { _meta: { block: { number: 42 } } } }));
    const g = apikeyGateway(fetchImpl);

    const result = await g.query<{ _meta: { block: { number: number } } }>(SUBGRAPH, QUERY);

    expect(result.data._meta.block.number).toBe(42);
    expect(result.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(SUBGRAPH);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ query: QUERY });
  });

  it('sends the API key as a bearer token', async () => {
    const { fetchImpl, calls } = scriptedFetch(ok({ data: {} }));
    await apikeyGateway(fetchImpl).query(SUBGRAPH, QUERY);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer test-key');
  });

  it('sends no authorization header in x402 mode', async () => {
    const { fetchImpl, calls } = scriptedFetch(ok({ data: {} }));
    const g = new GraphGateway({ mode: 'x402', fetchImpl, retry: { sleep: noSleep } });
    await g.query(SUBGRAPH, QUERY);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBeUndefined();
  });

  it('passes variables through', async () => {
    const { fetchImpl, calls } = scriptedFetch(ok({ data: {} }));
    await apikeyGateway(fetchImpl).query(SUBGRAPH, QUERY, { first: 5 });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      query: QUERY,
      variables: { first: 5 },
    });
  });

  it('captures the indexer attestation', async () => {
    const { fetchImpl } = scriptedFetch(ok({ data: {} }, { 'graph-attestation': 'attest-abc' }));
    const result = await apikeyGateway(fetchImpl).query(SUBGRAPH, QUERY);
    expect(result.attestation).toBe('attest-abc');
  });

  it('rejects an empty query string before spending anything', async () => {
    const { fetchImpl, calls } = scriptedFetch(ok({ data: {} }));
    await expect(apikeyGateway(fetchImpl).query(SUBGRAPH, '  ')).rejects.toThrow(/empty/);
    expect(calls).toHaveLength(0);
  });
});

describe('the HTTP 200 that is actually a failure', () => {
  it('throws on a GraphQL errors array instead of returning empty data', async () => {
    // Live observation: POST with no Authorization header returns status 200
    // and this body. Trusting res.ok here hands an agent no evidence at all.
    const { fetchImpl } = scriptedFetch(
      ok({ errors: [{ message: 'auth error: missing authorization header' }] }),
    );

    const err = await apikeyGateway(fetchImpl)
      .query(SUBGRAPH, QUERY)
      .catch((e: unknown) => e as GraphQueryError);

    expect(err).toBeInstanceOf(GraphQueryError);
    expect(err.kind).toBe('graphql');
    expect(err.status).toBe(200);
    expect(err.graphqlErrors).toEqual(['auth error: missing authorization header']);
    expect(err.message).toMatch(/GRAPH_API_KEY is missing, wrong, or out of quota/);
  });

  it('points at the mode, not the key, when x402 hits the keyed endpoint', async () => {
    const { fetchImpl } = scriptedFetch(ok({ errors: [{ message: 'auth error: nope' }] }));
    const g = new GraphGateway({ mode: 'x402', fetchImpl, retry: { sleep: noSleep } });
    const err = await g.query(SUBGRAPH, QUERY).catch((e: unknown) => e as GraphQueryError);
    expect(err.message).toMatch(/check baseUrl and mode/);
  });

  it('does not retry a GraphQL error', async () => {
    const { fetchImpl, calls } = scriptedFetch(ok({ errors: [{ message: 'bad field' }] }));
    await apikeyGateway(fetchImpl).query(SUBGRAPH, QUERY).catch(() => undefined);
    expect(calls).toHaveLength(1);
  });

  it('throws when there is partial data alongside errors', async () => {
    // Partial data is worse than none: an agent would reason over half an
    // evidence set without knowing half was missing.
    const { fetchImpl } = scriptedFetch(ok({ data: { a: 1 }, errors: [{ message: 'partial' }] }));
    await expect(apikeyGateway(fetchImpl).query(SUBGRAPH, QUERY)).rejects.toThrow(/partial/);
  });

  it('throws on 200 with neither data nor errors', async () => {
    const { fetchImpl } = scriptedFetch(ok({ something: 'else' }));
    const err = await apikeyGateway(fetchImpl)
      .query(SUBGRAPH, QUERY)
      .catch((e: unknown) => e as GraphQueryError);
    expect(err.kind).toBe('malformed');
  });

  it('throws on a body that is not JSON', async () => {
    const { fetchImpl } = scriptedFetch(new Response('<html>gateway down</html>', { status: 200 }));
    const err = await apikeyGateway(fetchImpl)
      .query(SUBGRAPH, QUERY)
      .catch((e: unknown) => e as GraphQueryError);
    expect(err.kind).toBe('malformed');
    expect(err.message).toMatch(/not JSON/);
  });

  it('treats an explicit null data as missing', async () => {
    const { fetchImpl } = scriptedFetch(ok({ data: null }));
    await expect(apikeyGateway(fetchImpl).query(SUBGRAPH, QUERY)).rejects.toThrow(/neither/);
  });
});

describe('payment failures are never retried', () => {
  it('gives up on 402 after a single attempt', async () => {
    // Each attempt in x402 mode is a fresh payment. Retrying pays repeatedly
    // for answers that never arrive.
    const { fetchImpl, calls } = scriptedFetch(new Response('', { status: 402 }));
    const g = new GraphGateway({
      mode: 'x402',
      fetchImpl,
      retry: { attempts: 5, sleep: noSleep },
    });

    const err = await g.query(SUBGRAPH, QUERY).catch((e: unknown) => e as GraphQueryError);

    expect(err.kind).toBe('payment');
    expect(err.status).toBe(402);
    expect(err.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('explains that a 402 means the payment layer did not run', async () => {
    const { fetchImpl } = scriptedFetch(new Response('', { status: 402 }));
    const g = new GraphGateway({ mode: 'x402', fetchImpl, retry: { sleep: noSleep } });
    const err = await g.query(SUBGRAPH, QUERY).catch((e: unknown) => e as GraphQueryError);
    expect(err.message).toMatch(/payment-wrapping/);
  });
});

describe('retrying what is worth retrying', () => {
  it('retries a 429 and returns the eventual answer', async () => {
    const { fetchImpl, calls } = scriptedFetch(
      new Response('slow down', { status: 429 }),
      ok({ data: { fine: true } }),
    );
    const g = apikeyGateway(fetchImpl, { retry: { attempts: 3, sleep: noSleep } });

    const result = await g.query<{ fine: boolean }>(SUBGRAPH, QUERY);

    expect(result.data.fine).toBe(true);
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('waits as long as the gateway asks when it says Retry-After', async () => {
    const delays: number[] = [];
    const { fetchImpl } = scriptedFetch(
      new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
      ok({ data: {} }),
    );
    const g = apikeyGateway(fetchImpl, {
      retry: {
        attempts: 2,
        baseDelayMs: 100,
        sleep: async (ms: number) => {
          delays.push(ms);
        },
      },
    });

    await g.query(SUBGRAPH, QUERY);
    // Its number, not our backoff: 7 seconds rather than 100 ms.
    expect(delays).toEqual([7000]);
  });

  it('retries a 503 with exponential backoff', async () => {
    const delays: number[] = [];
    const { fetchImpl, calls } = scriptedFetch(new Response('down', { status: 503 }));
    const g = apikeyGateway(fetchImpl, {
      retry: {
        attempts: 3,
        baseDelayMs: 100,
        sleep: async (ms: number) => {
          delays.push(ms);
        },
      },
    });

    const err = await g.query(SUBGRAPH, QUERY).catch((e: unknown) => e as GraphQueryError);

    expect(calls).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
    expect(err.attempts).toBe(3);
  });

  it('caps the backoff', async () => {
    const delays: number[] = [];
    const { fetchImpl } = scriptedFetch(new Response('down', { status: 500 }));
    const g = apikeyGateway(fetchImpl, {
      retry: {
        attempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 2000,
        sleep: async (ms: number) => {
          delays.push(ms);
        },
      },
    });
    await g.query(SUBGRAPH, QUERY).catch(() => undefined);
    expect(delays).toEqual([1000, 2000, 2000, 2000]);
  });

  it('retries a transport failure and wraps it', async () => {
    const { fetchImpl, calls } = scriptedFetch(new Error('fetch failed'));
    const g = apikeyGateway(fetchImpl, { retry: { attempts: 2, sleep: noSleep } });

    const err = await g.query(SUBGRAPH, QUERY).catch((e: unknown) => e as GraphQueryError);

    expect(err.kind).toBe('network');
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/Could not reach the gateway/);
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry a 400', async () => {
    const { fetchImpl, calls } = scriptedFetch(new Response('bad query', { status: 400 }));
    const g = apikeyGateway(fetchImpl, { retry: { attempts: 4, sleep: noSleep } });

    const err = await g.query(SUBGRAPH, QUERY).catch((e: unknown) => e as GraphQueryError);

    expect(err.kind).toBe('http');
    expect(err.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('reports each retry so an agent can log why it is slow', async () => {
    const onRetry = vi.fn();
    const { fetchImpl } = scriptedFetch(new Response('', { status: 502 }), ok({ data: {} }));
    const g = apikeyGateway(fetchImpl, { retry: { attempts: 2, sleep: noSleep, onRetry } });
    await g.query(SUBGRAPH, QUERY);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![2]).toBeInstanceOf(GraphQueryError);
  });
});

describe('timeouts', () => {
  it('aborts an attempt that never answers', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const g = apikeyGateway(fetchImpl, { timeoutMs: 5, retry: { attempts: 1, sleep: noSleep } });

    const err = await g.query(SUBGRAPH, QUERY).catch((e: unknown) => e as GraphQueryError);

    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/timed out after 5 ms/);
  });
});

describe('what a query cost', () => {
  it('reads a settlement receipt as proof the money moved', async () => {
    const { fetchImpl } = scriptedFetch(
      ok(
        { data: {} },
        {
          'payment-response': b64({
            success: true,
            transaction: '0xabc123',
            network: 'eip155:8453',
            asset: BASE_USDC,
            amount: '10000',
          }),
        },
      ),
    );
    const g = new GraphGateway({ mode: 'x402', fetchImpl, retry: { sleep: noSleep } });

    const result = await g.query(SUBGRAPH, QUERY);

    expect(result.cost.settled).toBe(true);
    expect(result.cost.estimated).toBe(false);
    expect(result.cost.source).toBe('settlement');
    expect(result.cost.usd).toBe(0.01);
    expect(result.costUsd).toBe(0.01);
    expect(result.paymentProof).toBe('0xabc123');
  });

  it('reports settled AND estimated when the receipt carries no amount', async () => {
    // Both facts are true and neither can be dropped: money definitely moved,
    // and the figure is still the list price rather than a measurement.
    const { fetchImpl } = scriptedFetch(
      ok({ data: {} }, { 'payment-response': b64({ transaction: '0xdef' }) }),
    );
    const g = new GraphGateway({ mode: 'x402', fetchImpl, retry: { sleep: noSleep } });

    const result = await g.query(SUBGRAPH, QUERY);

    expect(result.cost.settled).toBe(true);
    expect(result.cost.estimated).toBe(true);
    expect(result.cost.source).toBe('list-price');
    expect(result.cost.usd).toBe(0.01);
    expect(result.paymentProof).toBe('0xdef');
  });

  it('still counts a receipt it cannot parse', async () => {
    const { fetchImpl } = scriptedFetch(ok({ data: {} }, { 'payment-response': 'not-base64-json' }));
    const g = new GraphGateway({ mode: 'x402', fetchImpl, retry: { sleep: noSleep } });
    const result = await g.query(SUBGRAPH, QUERY);
    expect(result.cost.settled).toBe(true);
  });

  it('falls back to the list price when nothing was paid', async () => {
    const { fetchImpl } = scriptedFetch(ok({ data: {} }));
    const result = await apikeyGateway(fetchImpl).query(SUBGRAPH, QUERY);
    expect(result.cost.settled).toBe(false);
    expect(result.cost.estimated).toBe(true);
    expect(result.cost.usd).toBe(0.01);
  });

  it('honours a configured list price', async () => {
    const { fetchImpl } = scriptedFetch(ok({ data: {} }));
    const g = apikeyGateway(fetchImpl, { listPriceUsd: 0.004 });
    const result = await g.query(SUBGRAPH, QUERY);
    expect(result.cost.usd).toBe(0.004);
  });
});

describe('spend accounting', () => {
  it('adds up what the evidence has cost', async () => {
    const { fetchImpl } = scriptedFetch(ok({ data: {} }));
    const g = apikeyGateway(fetchImpl);

    await g.query(SUBGRAPH, QUERY);
    await g.query(SUBGRAPH, QUERY);
    await g.query(SUBGRAPH, QUERY);

    expect(g.spend.queries).toBe(3);
    expect(g.spend.totalUsd).toBe(0.03);
    expect(g.spend.estimatedUsd).toBe(0.03);
    expect(g.spend.settledQueries).toBe(0);
  });

  it('separates money proved spent from money assumed spent', async () => {
    const { fetchImpl } = scriptedFetch(
      ok(
        { data: {} },
        {
          'payment-response': b64({
            transaction: '0x1',
            network: 'eip155:8453',
            asset: BASE_USDC,
            amount: '20000',
          }),
        },
      ),
    );
    const g = new GraphGateway({ mode: 'x402', fetchImpl, retry: { sleep: noSleep } });

    await g.query(SUBGRAPH, QUERY);

    expect(g.spend.settledUsd).toBe(0.02);
    expect(g.spend.estimatedUsd).toBe(0);
    expect(g.spend.settledQueries).toBe(1);
  });

  it('counts a query that was paid for and still failed', async () => {
    // The money is gone whether or not the data arrived. Leaving these out
    // would understate what the evidence layer actually costs.
    const { fetchImpl } = scriptedFetch(
      ok(
        { errors: [{ message: 'indexer error' }] },
        {
          'payment-response': b64({
            transaction: '0x2',
            network: 'eip155:8453',
            asset: BASE_USDC,
            amount: '10000',
          }),
        },
      ),
    );
    const g = new GraphGateway({ mode: 'x402', fetchImpl, retry: { sleep: noSleep } });

    await g.query(SUBGRAPH, QUERY).catch(() => undefined);

    expect(g.spend.queries).toBe(1);
    expect(g.spend.totalUsd).toBe(0.01);
    expect(g.history[0]!.ok).toBe(false);
    expect(g.history[0]!.transaction).toBe('0x2');
  });

  it('does not charge for a query that never reached the gateway', async () => {
    const { fetchImpl } = scriptedFetch(new Error('fetch failed'));
    const g = apikeyGateway(fetchImpl, { retry: { attempts: 1, sleep: noSleep } });
    await g.query(SUBGRAPH, QUERY).catch(() => undefined);
    expect(g.spend.queries).toBe(0);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');

  it('reads a seconds value', () => {
    expect(parseRetryAfter('12', now)).toBe(12000);
    expect(parseRetryAfter('0', now)).toBe(0);
  });

  it('reads an HTTP date', () => {
    expect(parseRetryAfter('Thu, 10 Sep 2026 12:00:30 GMT', now)).toBe(30000);
  });

  it('never returns a negative wait for a date in the past', () => {
    expect(parseRetryAfter('Thu, 10 Sep 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('gives up on anything else so the caller uses its own backoff', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('', now)).toBeUndefined();
  });
});
