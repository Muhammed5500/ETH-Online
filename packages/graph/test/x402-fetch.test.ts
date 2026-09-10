/**
 * Payment-fetch tests.
 *
 * Only the checks that run BEFORE the signing stack loads are tested here.
 * `createX402Fetch` itself imports viem on demand, and pulling that into the
 * unit suite would cost more than the assertion is worth — the roadmap keeps
 * `pnpm test` offline and in the seconds. What is worth testing is that a
 * malformed key is caught at the `.env` boundary rather than thrown from six
 * frames inside a signer.
 */
import { describe, expect, it } from 'vitest';
import { X402_CHAIN_IDS, assertPrivateKey, createX402Fetch } from '../src/x402-fetch.js';
import { GraphQueryError } from '../src/errors.js';

describe('assertPrivateKey', () => {
  it('accepts a 32-byte hex key', () => {
    expect(() => assertPrivateKey(`0x${'a'.repeat(64)}`)).not.toThrow();
    expect(() => assertPrivateKey(`0x${'F'.repeat(64)}`)).not.toThrow();
  });

  it('rejects a key with no 0x prefix', () => {
    expect(() => assertPrivateKey('a'.repeat(64))).toThrow(GraphQueryError);
  });

  it('rejects the wrong length', () => {
    expect(() => assertPrivateKey(`0x${'a'.repeat(63)}`)).toThrow(/64 hex/);
    expect(() => assertPrivateKey(`0x${'a'.repeat(65)}`)).toThrow(/64 hex/);
  });

  it('rejects non-hex characters', () => {
    expect(() => assertPrivateKey(`0x${'z'.repeat(64)}`)).toThrow(/64 hex/);
  });

  it('says which kind of key it wants', () => {
    // The likeliest mistake is pasting the Hedera operator key, which is DER
    // and looks nothing like this. Naming both avoids a confusing hunt.
    const err = (() => {
      try {
        assertPrivateKey('nonsense');
        return undefined;
      } catch (e) {
        return e as GraphQueryError;
      }
    })();
    expect(err?.kind).toBe('config');
    expect(err?.message).toMatch(/not a Hedera key/);
  });
});

describe('chains', () => {
  it('maps to the CAIP-2 ids the gateway quotes', () => {
    // eip155:8453 is what the live 402 challenge asks to be paid on.
    expect(X402_CHAIN_IDS.base).toBe('eip155:8453');
    expect(X402_CHAIN_IDS['base-sepolia']).toBe('eip155:84532');
  });
});

describe('createX402Fetch', () => {
  it('refuses a bad key before importing anything', async () => {
    await expect(createX402Fetch({ privateKey: 'nope' })).rejects.toThrow(/64 hex/);
  });

  it('refuses a chain the gateway does not settle on', async () => {
    await expect(
      createX402Fetch({ privateKey: `0x${'a'.repeat(64)}`, chain: 'ethereum' as never }),
    ).rejects.toThrow(/base/);
  });
});
