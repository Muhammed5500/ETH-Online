/**
 * Talking to Sepolia, and who talks.
 *
 * ONE KEY, TWO CHAINS. The account that owns the registry and writes an
 * agent's score here is the same Hedera operator that runs the orchestrator,
 * writes to HCS and pays settlements. Its key is secp256k1, so it derives an
 * Ethereum address as readily as a Hedera account id, and no separate Sepolia
 * key had to be created or funded.
 *
 * That is not a convenience, it is the claim: the entity that ran the market
 * and the entity that published the record are provably the same key, rather
 * than two identities somebody asserts are related. The same holds one level
 * down — an agent's ENS name is owned by the address derived from the key it
 * signs its reports with.
 *
 * READS NEED NOTHING. Resolving a name costs no gas and no key, so the public
 * client is built from an RPC URL alone. Only the write path asks for a key,
 * and it says so when there is not one.
 */
import { createPublicClient, createWalletClient, http, type Address, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { ENS_CHAIN_ID } from './deployment.js';

/** A public RPC works: reads are free and nothing here needs an API key. */
export const DEFAULT_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

export function sepoliaRpcUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['SEPOLIA_RPC_URL']?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_SEPOLIA_RPC;
}

export function ensChain(): Chain {
  if (sepolia.id !== ENS_CHAIN_ID) {
    throw new Error(`viem's sepolia chain id is ${sepolia.id}, expected ${ENS_CHAIN_ID}.`);
  }
  return sepolia;
}

export function publicSepolia(env: NodeJS.ProcessEnv = process.env) {
  return createPublicClient({ chain: ensChain(), transport: http(sepoliaRpcUrl(env)) });
}

/**
 * Normalises a secp256k1 private key to what viem wants.
 *
 * Hedera keys are stored in whatever form the tool that made them produced:
 * DER, `0x`-prefixed hex, or bare hex. Only the last 32 bytes are the scalar,
 * and a DER wrapper in front of it is why a key that works on Hedera can be
 * rejected here with an unhelpful "invalid private key".
 */
export function toEvmPrivateKey(raw: string): `0x${string}` {
  const clean = raw.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error('The key is not hex. Expected a secp256k1 key, DER or raw.');
  }
  if (clean.length === 64) return `0x${clean}`;
  // DER-encoded keys end with the 32-byte scalar.
  if (clean.length > 64) return `0x${clean.slice(-64)}`;
  throw new Error(`A secp256k1 key is 32 bytes; this is ${clean.length / 2}.`);
}

export interface EnsSigner {
  readonly address: Address;
  readonly wallet: ReturnType<typeof createWalletClient>;
  readonly publicClient: ReturnType<typeof createPublicClient>;
}

/**
 * The orchestrator's Sepolia signer, derived from the Hedera operator key.
 *
 * `SEPOLIA_PRIVATE_KEY` takes precedence when it is set, for a deployment that
 * wants the two roles held by different keys. Nothing here requires them to be
 * separate, and this project deliberately keeps them the same.
 */
export function orchestratorSigner(env: NodeJS.ProcessEnv = process.env): EnsSigner {
  const raw = env['SEPOLIA_PRIVATE_KEY']?.trim() || env['HEDERA_OPERATOR_KEY']?.trim();
  if (!raw) {
    throw new Error(
      'No key for Sepolia. Set SEPOLIA_PRIVATE_KEY, or HEDERA_OPERATOR_KEY to reuse the ' +
        'operator identity on both chains.',
    );
  }
  const account = privateKeyToAccount(toEvmPrivateKey(raw));
  const chain = ensChain();
  const transport = http(sepoliaRpcUrl(env));
  return {
    address: account.address,
    wallet: createWalletClient({ account, chain, transport }),
    publicClient: createPublicClient({ chain, transport }),
  };
}

/** The EVM address a Hedera ECDSA key controls. Used for agent name ownership. */
export function evmAddressFromKey(raw: string): Address {
  return privateKeyToAccount(toEvmPrivateKey(raw)).address;
}
