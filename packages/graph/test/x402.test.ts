/**
 * x402 header tests.
 *
 * The fixture below is not invented. It is the exact `payment-required` header
 * the production gateway sent on 2026-09-10 in answer to an unpaid POST, kept
 * verbatim so that a change in what the gateway says shows up here as a failing
 * test rather than as a wrong number on a demo slide.
 */
import { describe, expect, it } from 'vitest';
import {
  KNOWN_ASSETS,
  amountToDecimal,
  assetKey,
  decodeChallenge,
  decodeSettlement,
  lookupAsset,
  quoteFromChallenge,
} from '../src/x402.js';

/** Captured live: gateway.thegraph.com, unpaid POST, HTTP 402, empty body. */
const LIVE_CHALLENGE_HEADER =
  'eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50LVNpZ25hdHVyZSBoZWFkZXIgaXMgcmVxdWlyZWQiLCJyZXNvdXJjZSI6eyJ1cmwiOiJodHRwOi8vbWFpbm5ldC10aGVncmFwaC1hcmJpdHJ1bS0wMi1ldS13ZXN0My50aGVncmFwaC5jb20vc3ViZ3JhcGhzL2lkLzV6dlI4MlFvYVhZRnlERUtMWjl0NnY5YWRnbnB0eFlwS3BTYnh0Z1ZFTkZWIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzIiwiYW1vdW50IjoiMTAwMDAiLCJwYXlUbyI6IjB4NzlEQzM0RTQxQjJiNTkxMDc4ZDNkRTIyMkM0M0VjYWFCRDUyRmNDQiIsIm1heFRpbWVvdXRTZWNvbmRzIjozMDAsImFzc2V0IjoiMHg4MzM1ODlmQ0Q2ZURiNkUwOGY0YzdDMzJENGY3MWI1NGJkQTAyOTEzIiwiZXh0cmEiOnsiYXNzZXRUcmFuc2Zlck1ldGhvZCI6ImVpcDMwMDkiLCJuYW1lIjoiVVNEIENvaW4iLCJ2ZXJzaW9uIjoiMiJ9fV19';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64');
}

describe('decodeChallenge, against the header the gateway actually sent', () => {
  it('reads the live 402 challenge', () => {
    const c = decodeChallenge(LIVE_CHALLENGE_HEADER);

    expect(c.x402Version).toBe(2);
    expect(c.error).toBe('Payment-Signature header is required');
    expect(c.accepts).toHaveLength(1);

    const accept = c.accepts[0]!;
    expect(accept.scheme).toBe('exact');
    expect(accept.network).toBe('eip155:8453'); // Base mainnet, not a testnet
    expect(accept.amount).toBe('10000');
    expect(accept.asset).toBe(BASE_USDC);
    expect(accept.maxTimeoutSeconds).toBe(300);
    // eip3009 is why an agent needs USDC but no ETH: the facilitator pays gas.
    expect(accept.extra?.['assetTransferMethod']).toBe('eip3009');
  });

  it('prices that challenge at one cent', () => {
    const quote = quoteFromChallenge(decodeChallenge(LIVE_CHALLENGE_HEADER));
    expect(quote?.usd).toBe(0.01);
    expect(quote?.symbol).toBe('USDC');
    expect(quote?.amountRaw).toBe('10000');
  });

  it('accepts URL-safe base64 too', () => {
    const standard = b64({ x402Version: 2, accepts: [] });
    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_');
    expect(decodeChallenge(urlSafe).x402Version).toBe(2);
  });

  it('rejects a challenge that is not JSON', () => {
    expect(() => decodeChallenge(Buffer.from('not json').toString('base64'))).toThrow(/not valid JSON/);
  });

  it('rejects a challenge with no version', () => {
    expect(() => decodeChallenge(b64({ accepts: [] }))).toThrow(/x402Version/);
  });

  it('rejects an accepts entry missing the fields payment needs', () => {
    const bad = b64({ x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453' }] });
    expect(() => decodeChallenge(bad)).toThrow(/accepts/);
  });

  it('rejects a JSON array, which is not a challenge', () => {
    expect(() => decodeChallenge(b64([1, 2, 3]))).toThrow(/JSON object/);
  });
});

describe('quoteFromChallenge', () => {
  it('returns no dollar figure for an asset whose decimals we do not know', () => {
    // Guessing 6 would be right for USDC and wrong by 12 orders of magnitude
    // for an 18-decimal token. No figure beats a confident wrong one.
    const c = decodeChallenge(
      b64({
        x402Version: 2,
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            amount: '1000000000000000000',
            payTo: '0xabc',
            asset: '0xNotAnAssetWeKnow',
          },
        ],
      }),
    );
    const quote = quoteFromChallenge(c);
    expect(quote?.amountRaw).toBe('1000000000000000000');
    expect(quote?.usd).toBeUndefined();
    expect(quote?.symbol).toBeUndefined();
  });

  it('returns undefined when there is nothing on offer', () => {
    expect(quoteFromChallenge(decodeChallenge(b64({ x402Version: 2, accepts: [] })))).toBeUndefined();
  });
});

describe('amountToDecimal', () => {
  it('converts USDC amounts', () => {
    expect(amountToDecimal('10000', 6)).toBe(0.01);
    expect(amountToDecimal('1000000', 6)).toBe(1);
    expect(amountToDecimal('1', 6)).toBe(0.000001);
    expect(amountToDecimal('0', 6)).toBe(0);
  });

  it('survives a uint256 that does not fit a double', () => {
    // Number("123456789012345678901234567890") loses digits silently. Parsing
    // through BigInt first is the only reason this comes out right.
    expect(amountToDecimal('1000000000000000000', 18)).toBe(1);
    expect(amountToDecimal('123456789012345678', 18)).toBeCloseTo(0.123456789012345678, 12);
  });

  it('handles zero decimals', () => {
    expect(amountToDecimal('42', 0)).toBe(42);
  });

  it('rejects anything that is not a decimal integer string', () => {
    expect(() => amountToDecimal('1.5', 6)).toThrow(/decimal integer/);
    expect(() => amountToDecimal('0x10', 6)).toThrow(/decimal integer/);
    expect(() => amountToDecimal('-1', 6)).toThrow(/decimal integer/);
    expect(() => amountToDecimal('', 6)).toThrow(/decimal integer/);
  });

  it('rejects impossible decimals', () => {
    expect(() => amountToDecimal('1', -1)).toThrow(/decimals/);
    expect(() => amountToDecimal('1', 1.5)).toThrow(/decimals/);
  });
});

describe('asset lookup', () => {
  it('is case-insensitive about the address', () => {
    expect(lookupAsset('eip155:8453', BASE_USDC)?.symbol).toBe('USDC');
    expect(lookupAsset('eip155:8453', BASE_USDC.toLowerCase())?.symbol).toBe('USDC');
    expect(lookupAsset('eip155:8453', BASE_USDC.toUpperCase().replace('0X', '0x'))?.symbol).toBe(
      'USDC',
    );
  });

  it('does not confuse two chains that share an address shape', () => {
    expect(lookupAsset('eip155:1', BASE_USDC)).toBeUndefined();
  });

  it('marks which entries have actually been seen from the gateway', () => {
    // The testnet gateway is not deployed, so its entry is documented but
    // unobserved. Saying so keeps the demo's claims honest.
    expect(KNOWN_ASSETS[assetKey('eip155:8453', BASE_USDC)]?.observed).toBe(true);
    expect(
      KNOWN_ASSETS[assetKey('eip155:84532', '0x036CbD53842c5426634e7929541eC2318f3dCF7e')]?.observed,
    ).toBe(false);
  });
});

describe('decodeSettlement', () => {
  it('reads a receipt', () => {
    const s = decodeSettlement(
      b64({ success: true, transaction: '0xdeadbeef', network: 'eip155:8453', payer: '0xpayer' }),
    );
    expect(s.success).toBe(true);
    expect(s.transaction).toBe('0xdeadbeef');
    expect(s.network).toBe('eip155:8453');
    expect(s.payer).toBe('0xpayer');
  });

  it('keeps fields it does not recognise instead of dropping them', () => {
    // The EVM settlement payload has not been observed from this repo yet.
    // Losing an unexpected field would hide exactly the thing worth noticing.
    const s = decodeSettlement(b64({ transaction: '0x1', somethingNew: { nested: 1 } }));
    expect(s.raw['somethingNew']).toEqual({ nested: 1 });
  });

  it('tolerates a receipt with nothing familiar in it', () => {
    const s = decodeSettlement(b64({}));
    expect(s.transaction).toBeUndefined();
    expect(s.raw).toEqual({});
  });
});
