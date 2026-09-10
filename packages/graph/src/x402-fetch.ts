/**
 * Building the fetch that pays.
 *
 * WHY THIS IS ONE SMALL FILE WITH A DYNAMIC IMPORT. `@graphprotocol/client-x402`
 * pulls in viem and the EVM signing stack. Loading that costs real time, and
 * `pnpm test` has to stay in the seconds and off the network, so the import
 * happens inside the function rather than at the top of the module. Nothing in
 * the unit suite ever touches it: `GraphGateway` takes its fetch by injection,
 * and the tests hand it a fake.
 *
 * WHY THE VENDOR'S PACKAGE RATHER THAN OUR OWN WRAPPER. It is a thin one — it
 * builds an `x402Client`, registers the exact-EVM scheme with a viem account,
 * and calls `wrapFetchWithPayment`. We could inline those three lines, and the
 * temptation was to do exactly that in order to set our own per-payment
 * ceiling. Two things argued the other way. The ceiling is already there:
 * `x402Client` applies default spend controls with a USD cap for recognised
 * assets, and USDC on Base is one of them. And this path cannot be exercised
 * offline — there is no test USDC and no testnet gateway (STEP 3) — so the
 * version that has been run by someone other than us is worth more than the
 * version we like the shape of.
 *
 * The escape hatch stays open regardless: `GraphGateway` accepts any
 * `fetchImpl`, so swapping in a wrapper with a project-set ceiling is a
 * constructor argument, not a rewrite.
 *
 * SPIKE A's trap, recorded here because it will look identical if it happens
 * on Base: when spend controls reject a payment the error reads "All payment
 * requirements were rejected by spendControls", which sounds like the server
 * refused us. It did not — our own client did.
 */
import type { FetchLike } from './gateway.js';
import { GraphQueryError } from './errors.js';

/** The chains the gateway's x402 endpoint settles on. */
export type X402Chain = 'base' | 'base-sepolia';

export const X402_CHAIN_IDS: Readonly<Record<X402Chain, string>> = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
};

export interface X402FetchOptions {
  /** The key that signs payment authorisations. `0x` + 64 hex characters. */
  readonly privateKey: string;
  /** Defaults to `base`. Note that `base-sepolia` needs the testnet gateway, which is not deployed. */
  readonly chain?: X402Chain;
}

/** Shape of the vendor module, narrowed to what we call. */
interface GraphX402Module {
  fetch?: (
    url: string | URL | Request,
    options?: RequestInit,
    context?: { config?: { x402PrivateKey?: string; x402Chain?: X402Chain } },
  ) => Promise<Response>;
  default?: GraphX402Module['fetch'];
}

/**
 * A private key mistake is worth catching before it becomes a signing error.
 *
 * The failure mode without this check is a viem exception thrown from deep
 * inside the payment stack, several frames away from the `.env` line that
 * actually caused it.
 */
export function assertPrivateKey(key: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new GraphQueryError(
      'GRAPH_X402_PRIVATE_KEY must be "0x" followed by 64 hex characters. ' +
        'This is an Ethereum key that signs USDC transfer authorisations on Base; ' +
        'it is not a Hedera key and not an API key.',
      { kind: 'config' },
    );
  }
}

/**
 * Creates a fetch that answers a 402 by paying it.
 *
 * The key is passed through the call context rather than left to
 * `X402_PRIVATE_KEY` in the environment. The library reads that variable as a
 * fallback, but relying on it would mean the payer identity is whatever the
 * process happens to have exported — and in STEP 20 each of twenty agents pays
 * with its own key inside one process, so an ambient key is the wrong shape
 * entirely.
 */
export async function createX402Fetch(opts: X402FetchOptions): Promise<FetchLike> {
  assertPrivateKey(opts.privateKey);
  const chain: X402Chain = opts.chain ?? 'base';
  if (!X402_CHAIN_IDS[chain]) {
    throw new GraphQueryError(
      `x402 chain must be "base" or "base-sepolia", got: ${JSON.stringify(chain)}`,
      { kind: 'config' },
    );
  }

  let mod: GraphX402Module;
  try {
    mod = (await import('@graphprotocol/client-x402')) as unknown as GraphX402Module;
  } catch (e) {
    throw new GraphQueryError(
      `Could not load @graphprotocol/client-x402: ${(e as Error).message}. ` +
        'It is only needed in x402 mode; apikey mode runs without it.',
      { kind: 'config', cause: e },
    );
  }

  const paidFetch = mod.fetch ?? mod.default;
  if (typeof paidFetch !== 'function') {
    throw new GraphQueryError(
      '@graphprotocol/client-x402 did not export a fetch function. The package layout has ' +
        'changed; pin the version that does.',
      { kind: 'config' },
    );
  }

  return (url, init) =>
    paidFetch(url, init, { config: { x402PrivateKey: opts.privateKey, x402Chain: chain } });
}
