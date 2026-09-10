/**
 * Gateway configuration, read from the environment.
 *
 * Same discipline as the Hedera package: this module takes an env object
 * rather than reaching for `process.env` itself, and it never calls `dotenv`.
 * That keeps the whole surface unit-testable with no file on disk, and lets an
 * app inject configuration from somewhere else — which STEP 20 needs, because
 * twenty agents each pay with their own key inside a single process.
 */
import { GraphQueryError } from './errors.js';
import {
  DEFAULT_GATEWAY_URL,
  GraphGateway,
  type GatewayConfig,
  type GatewayMode,
} from './gateway.js';
import { createX402Fetch, type X402Chain } from './x402-fetch.js';

/**
 * Reads a variable, treating an empty value as absent.
 *
 * `.env` turns `KEY=` into the empty string, not `undefined`. `??` does not
 * catch that and `||` does — the trap that cost time in SPIKE A, where an
 * empty facilitator URL silently became `''` and the request went nowhere.
 * It matters more here than there: `GRAPH_API_KEY=` with nothing after it
 * would build an `Authorization: Bearer ` header, and the gateway answers that
 * with HTTP 200 and an auth error in the body.
 */
export function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

export interface GraphEnvConfig {
  readonly mode: GatewayMode;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly x402PrivateKey?: string;
  readonly x402Chain?: X402Chain;
}

export function parseMode(raw: string | undefined): GatewayMode {
  const v = (raw ?? 'apikey').toLowerCase();
  if (v !== 'x402' && v !== 'apikey') {
    throw new GraphQueryError(
      `GRAPH_GATEWAY_MODE must be "x402" or "apikey", got: ${JSON.stringify(raw)}`,
      { kind: 'config' },
    );
  }
  return v;
}

export function parseChain(raw: string | undefined): X402Chain | undefined {
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase();
  if (v !== 'base' && v !== 'base-sepolia') {
    throw new GraphQueryError(
      `GRAPH_X402_CHAIN must be "base" or "base-sepolia", got: ${JSON.stringify(raw)}`,
      { kind: 'config' },
    );
  }
  return v;
}

/**
 * Reads the configuration and checks the mode has what it needs.
 *
 * Checked here rather than at first query, because the first query in x402
 * mode costs money and the first query in apikey mode returns a 200 that looks
 * like an empty result. Both are much worse than a startup error.
 */
export function graphConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GraphEnvConfig {
  const mode = parseMode(readEnv(env, 'GRAPH_GATEWAY_MODE'));
  const apiKey = readEnv(env, 'GRAPH_API_KEY');
  const x402PrivateKey = readEnv(env, 'GRAPH_X402_PRIVATE_KEY');
  const chain = parseChain(readEnv(env, 'GRAPH_X402_CHAIN'));

  if (mode === 'apikey' && !apiKey) {
    throw new GraphQueryError(
      'GRAPH_GATEWAY_MODE=apikey but GRAPH_API_KEY is missing or empty. ' +
        'A Studio key is free at thegraph.com/studio.',
      { kind: 'config' },
    );
  }
  if (mode === 'x402' && !x402PrivateKey) {
    throw new GraphQueryError(
      'GRAPH_GATEWAY_MODE=x402 but GRAPH_X402_PRIVATE_KEY is missing or empty. ' +
        'x402 mode pays per query in USDC on Base mainnet, so it needs a funded key.',
      { kind: 'config' },
    );
  }

  return {
    mode,
    baseUrl: readEnv(env, 'GRAPH_GATEWAY_URL') ?? DEFAULT_GATEWAY_URL,
    ...(apiKey ? { apiKey } : {}),
    ...(x402PrivateKey ? { x402PrivateKey } : {}),
    ...(chain ? { x402Chain: chain } : {}),
  };
}

export interface GatewayFromEnvOptions
  extends Omit<GatewayConfig, 'mode' | 'baseUrl' | 'apiKey' | 'fetchImpl'> {
  /** Overrides the payment fetch. Mostly for tests and for a stricter spend ceiling. */
  readonly fetchImpl?: GatewayConfig['fetchImpl'];
}

/**
 * Builds a gateway from the environment, wiring up payment when the mode asks
 * for it.
 *
 * Async because x402 mode loads the signing stack on demand; apikey mode
 * resolves without touching it.
 */
export async function createGatewayFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: GatewayFromEnvOptions = {},
): Promise<GraphGateway> {
  const cfg = graphConfigFromEnv(env);

  const fetchImpl =
    opts.fetchImpl ??
    (cfg.mode === 'x402'
      ? await createX402Fetch({
          privateKey: cfg.x402PrivateKey!,
          ...(cfg.x402Chain ? { chain: cfg.x402Chain } : {}),
        })
      : undefined);

  return new GraphGateway({
    ...opts,
    mode: cfg.mode,
    baseUrl: cfg.baseUrl,
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/**
 * Which subgraphs a question is about, read from the environment.
 *
 * Deliberately configuration and not a constant. A Messari deployment id is a
 * fact about somebody else's infrastructure that we cannot verify without a
 * gateway credential, and hardcoding a guess would produce a query that fails
 * against the real gateway while passing every test here. STEP 21 will pin the
 * demo's ids once they have actually answered.
 */
export interface QuestionTargets {
  readonly subgraphId?: string;
  readonly peerSubgraphIds: readonly string[];
  readonly bridgeSubgraphId?: string;
}

export function questionTargetsFromEnv(env: NodeJS.ProcessEnv = process.env): QuestionTargets {
  const peers = readEnv(env, 'GRAPH_PEER_SUBGRAPHS');
  return {
    ...(readEnv(env, 'GRAPH_SUBJECT_SUBGRAPH')
      ? { subgraphId: readEnv(env, 'GRAPH_SUBJECT_SUBGRAPH')! }
      : {}),
    peerSubgraphIds: peers
      ? peers
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '')
      : [],
    ...(readEnv(env, 'GRAPH_BRIDGE_SUBGRAPH')
      ? { bridgeSubgraphId: readEnv(env, 'GRAPH_BRIDGE_SUBGRAPH')! }
      : {}),
  };
}
