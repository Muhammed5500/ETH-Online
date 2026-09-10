/**
 * Environment tests.
 *
 * The failure this file exists to prevent: `GRAPH_API_KEY=` with nothing after
 * it. `??` does not treat an empty string as absent, so the config would be
 * "valid", the client would send `Authorization: Bearer `, and the gateway
 * would answer HTTP 200 with an auth error in the GraphQL body. That looks
 * like a subgraph with no data in it, which is a long way from the truth.
 */
import { describe, expect, it } from 'vitest';
import {
  createGatewayFromEnv,
  graphConfigFromEnv,
  parseChain,
  parseMode,
  questionTargetsFromEnv,
  readEnv,
} from '../src/env.js';
import { DEFAULT_GATEWAY_URL } from '../src/gateway.js';

const KEY = '0x'.padEnd(66, 'a');

describe('readEnv', () => {
  it('treats an empty or whitespace value as absent', () => {
    expect(readEnv({ A: '' }, 'A')).toBeUndefined();
    expect(readEnv({ A: '   ' }, 'A')).toBeUndefined();
    expect(readEnv({}, 'A')).toBeUndefined();
  });

  it('trims what it returns', () => {
    expect(readEnv({ A: '  value  ' }, 'A')).toBe('value');
  });
});

describe('parseMode', () => {
  it('accepts both modes, case-insensitively', () => {
    expect(parseMode('x402')).toBe('x402');
    expect(parseMode('APIKEY')).toBe('apikey');
  });

  it('defaults to apikey, the one that cannot spend money by accident', () => {
    expect(parseMode(undefined)).toBe('apikey');
  });

  it('refuses anything else', () => {
    expect(() => parseMode('free')).toThrow(/GRAPH_GATEWAY_MODE/);
  });
});

describe('parseChain', () => {
  it('accepts the two chains the gateway settles on', () => {
    expect(parseChain('base')).toBe('base');
    expect(parseChain('base-sepolia')).toBe('base-sepolia');
  });

  it('returns undefined when unset so the default applies', () => {
    expect(parseChain(undefined)).toBeUndefined();
  });

  it('refuses a chain the gateway does not settle on', () => {
    expect(() => parseChain('ethereum')).toThrow(/GRAPH_X402_CHAIN/);
  });
});

describe('graphConfigFromEnv', () => {
  it('reads apikey mode', () => {
    const cfg = graphConfigFromEnv({ GRAPH_GATEWAY_MODE: 'apikey', GRAPH_API_KEY: 'abc' });
    expect(cfg.mode).toBe('apikey');
    expect(cfg.apiKey).toBe('abc');
    expect(cfg.baseUrl).toBe(DEFAULT_GATEWAY_URL);
  });

  it('reads x402 mode', () => {
    const cfg = graphConfigFromEnv({
      GRAPH_GATEWAY_MODE: 'x402',
      GRAPH_X402_PRIVATE_KEY: KEY,
      GRAPH_X402_CHAIN: 'base',
    });
    expect(cfg.mode).toBe('x402');
    expect(cfg.x402PrivateKey).toBe(KEY);
    expect(cfg.x402Chain).toBe('base');
  });

  it('honours an override gateway url', () => {
    const cfg = graphConfigFromEnv({
      GRAPH_GATEWAY_MODE: 'apikey',
      GRAPH_API_KEY: 'abc',
      GRAPH_GATEWAY_URL: 'https://example.test',
    });
    expect(cfg.baseUrl).toBe('https://example.test');
  });

  it('rejects apikey mode with an EMPTY key, not just a missing one', () => {
    expect(() => graphConfigFromEnv({ GRAPH_GATEWAY_MODE: 'apikey', GRAPH_API_KEY: '' })).toThrow(
      /GRAPH_API_KEY is missing or empty/,
    );
  });

  it('rejects x402 mode with no key', () => {
    expect(() => graphConfigFromEnv({ GRAPH_GATEWAY_MODE: 'x402' })).toThrow(
      /GRAPH_X402_PRIVATE_KEY/,
    );
  });

  it('says out loud that x402 mode spends real money', () => {
    // STEP 3: the testnet gateway is not deployed, so x402 means Base mainnet.
    // Anyone who trips this error should learn that from the error itself.
    const err = (() => {
      try {
        graphConfigFromEnv({ GRAPH_GATEWAY_MODE: 'x402' });
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toMatch(/Base mainnet/);
  });
});

describe('createGatewayFromEnv', () => {
  it('builds an apikey gateway without loading the signing stack', async () => {
    const g = await createGatewayFromEnv({ GRAPH_GATEWAY_MODE: 'apikey', GRAPH_API_KEY: 'abc' });
    expect(g.mode).toBe('apikey');
    expect(g.endpointFor('abc123')).toContain('/api/subgraphs/id/abc123');
  });

  it('lets a caller inject a fetch instead of building the payment one', async () => {
    // This is the seam for a stricter spend ceiling, and the one the unit
    // tests use so that x402 mode never pulls in viem.
    const g = await createGatewayFromEnv(
      { GRAPH_GATEWAY_MODE: 'x402', GRAPH_X402_PRIVATE_KEY: KEY },
      { fetchImpl: async () => new Response('{}', { status: 200 }) },
    );
    expect(g.mode).toBe('x402');
    expect(g.endpointFor('abc123')).toContain('/api/x402/subgraphs/id/abc123');
  });

  it('passes options through to the gateway', async () => {
    const g = await createGatewayFromEnv(
      { GRAPH_GATEWAY_MODE: 'apikey', GRAPH_API_KEY: 'abc' },
      { listPriceUsd: 0.5, retry: { attempts: 1 } },
    );
    expect(g).toBeDefined();
  });
});

describe('questionTargetsFromEnv', () => {
  it('splits the peer list and trims each entry', () => {
    const t = questionTargetsFromEnv({
      GRAPH_SUBJECT_SUBGRAPH: 'subject',
      GRAPH_PEER_SUBGRAPHS: ' a , b ,c ',
      GRAPH_BRIDGE_SUBGRAPH: 'bridge',
    });
    expect(t.subgraphId).toBe('subject');
    expect(t.peerSubgraphIds).toEqual(['a', 'b', 'c']);
    expect(t.bridgeSubgraphId).toBe('bridge');
  });

  it('drops empty entries left by a trailing comma', () => {
    const t = questionTargetsFromEnv({ GRAPH_PEER_SUBGRAPHS: 'a,,b,' });
    expect(t.peerSubgraphIds).toEqual(['a', 'b']);
  });

  it('returns an empty peer list rather than undefined', () => {
    // The comparative slice iterates this; undefined would be a crash where
    // "no peers configured" is a perfectly ordinary state.
    const t = questionTargetsFromEnv({});
    expect(t.peerSubgraphIds).toEqual([]);
    expect(t.subgraphId).toBeUndefined();
    expect(t.bridgeSubgraphId).toBeUndefined();
  });
});
