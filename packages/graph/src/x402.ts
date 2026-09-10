/**
 * Reading the x402 headers The Graph's gateway speaks.
 *
 * WHY THIS IS A SEPARATE, DEPENDENCY-FREE FILE. Paying for a query is the one
 * part of the evidence layer that costs real money, so what a payment cost has
 * to be checkable without trusting the library that made it. Everything here
 * is string and integer arithmetic over two headers: no signer, no viem, no
 * network. `pnpm test` covers the money arithmetic in milliseconds.
 *
 * WHAT WAS OBSERVED LIVE (2026-09-10, production gateway, no payment sent):
 *
 *   POST https://gateway.thegraph.com/api/x402/subgraphs/id/<id>
 *   -> HTTP/1.1 402 Payment Required
 *      Content-Length: 0
 *      payment-required: <base64 JSON>
 *
 * The challenge is in a HEADER and the body is EMPTY. That is worth stating
 * because STEP 3 recorded the challenge as a JSON body, and a client written
 * against that memory would read `await res.json()`, get a parse error on zero
 * bytes, and report "malformed response" for what is actually a perfectly
 * ordinary request for payment.
 *
 * Decoded, that header says:
 *
 *   { "x402Version": 2,
 *     "error": "Payment-Signature header is required",
 *     "resource": { "url": "http://mainnet-thegraph-arbitrum-02-.../subgraphs/id/<id>" },
 *     "accepts": [ { "scheme": "exact",
 *                    "network": "eip155:8453",          // Base mainnet
 *                    "amount": "10000",                 // 0.01 USDC, 6 decimals
 *                    "payTo": "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
 *                    "maxTimeoutSeconds": 300,
 *                    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
 *                    "extra": { "assetTransferMethod": "eip3009",
 *                               "name": "USD Coin", "version": "2" } } ] }
 *
 * `eip3009` means the payer signs a transfer authorisation and the facilitator
 * pays the gas. An agent therefore needs USDC on Base and no ETH at all, which
 * is what makes twenty agents paying for their own evidence practical.
 */

/** Where the gateway puts its 402 challenge. Response header, base64 JSON. */
export const PAYMENT_CHALLENGE_HEADER = 'payment-required';

/**
 * Where the settlement receipt comes back.
 *
 * SPIKE A (Hedera) established the name the hard way: `payment-response`, NOT
 * `x-payment-response`. Reading the wrong name returns nothing and looks
 * exactly like a failed payment while the money has in fact moved.
 */
export const PAYMENT_SETTLEMENT_HEADER = 'payment-response';

/**
 * What the gateway asks for on the way back in.
 *
 * Named here only so the 402 challenge's own error string (`Payment-Signature
 * header is required`) can be recognised for what it is. We never build this
 * header ourselves — the x402 client does.
 */
export const PAYMENT_SIGNATURE_HEADER = 'Payment-Signature';

/** The Graph's attestation of which indexer served the data. */
export const ATTESTATION_HEADER = 'graph-attestation';

export interface X402Accept {
  readonly scheme: string;
  /** CAIP-2, e.g. `eip155:8453` for Base mainnet. */
  readonly network: string;
  /** Smallest-unit amount, as a decimal string. Never a number: it is a uint256. */
  readonly amount: string;
  readonly payTo: string;
  readonly asset: string;
  readonly maxTimeoutSeconds?: number;
  readonly extra?: Record<string, unknown>;
}

export interface X402Challenge {
  readonly x402Version: number;
  readonly error?: string;
  readonly resource?: { readonly url?: string };
  readonly accepts: readonly X402Accept[];
}

/**
 * A settlement receipt.
 *
 * Parsed defensively. The header NAME is confirmed (SPIKE A), but this repo has
 * not yet made a paid EVM query, so the exact field names in the payload are
 * not something we have seen with our own eyes. Every field is therefore
 * optional and a receipt we cannot fully read still counts as proof that a
 * payment happened — which is the only claim the cost accounting rests on.
 */
export interface X402Settlement {
  readonly success?: boolean;
  /** Transaction hash, when the payload carries one. */
  readonly transaction?: string;
  readonly network?: string;
  readonly payer?: string;
  /** Whatever else was in there, kept so a surprise is visible rather than lost. */
  readonly raw: Record<string, unknown>;
}

/** An asset we know how to price. Keyed `<caip2>/<address lowercased>`. */
export interface KnownAsset {
  readonly symbol: string;
  readonly decimals: number;
  /** True only for entries confirmed against the live gateway. */
  readonly observed: boolean;
}

/**
 * Decimals cannot be guessed.
 *
 * The 402 challenge carries an amount and an asset address but NOT the number
 * of decimals, so turning `"10000"` into `$0.01` needs knowledge from outside
 * the header. Assuming 6 would be right for USDC and silently wrong by a
 * factor of a hundred billion for an 18-decimal token. Anything not in this
 * table is reported as a raw amount with no dollar figure attached, which is
 * honest rather than convenient.
 */
export const KNOWN_ASSETS: Readonly<Record<string, KnownAsset>> = {
  // Confirmed live: this is what gateway.thegraph.com quotes today.
  'eip155:8453/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': {
    symbol: 'USDC',
    decimals: 6,
    observed: true,
  },
  // Documented for the testnet gateway. Unreachable as of 2026-09-10
  // (`testnet.gateway.thegraph.com` still has no address record), so it has
  // never answered us and is marked accordingly.
  'eip155:84532/0x036cbd53842c5426634e7929541ec2318f3dcf7e': {
    symbol: 'USDC',
    decimals: 6,
    observed: false,
  },
};

export function assetKey(network: string, asset: string): string {
  return `${network}/${asset.toLowerCase()}`;
}

export function lookupAsset(network: string, asset: string): KnownAsset | undefined {
  return KNOWN_ASSETS[assetKey(network, asset)];
}

/**
 * Smallest units to a decimal amount.
 *
 * Parsed as BigInt first, because a uint256 does not fit a double and
 * `Number("10000000000000000000")` quietly loses digits. The division to a
 * float happens only at the end, on a value small enough to survive it.
 */
export function amountToDecimal(amount: string, decimals: number): number {
  if (!/^\d+$/.test(amount)) {
    throw new Error(`x402 amount must be a decimal integer string, got: ${JSON.stringify(amount)}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`decimals must be an integer in [0, 36], got: ${decimals}`);
  }
  const units = BigInt(amount);
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = units % scale;
  return Number(whole) + Number(fraction) / Number(scale);
}

/** Base64 (standard or URL-safe) to a UTF-8 string. */
function fromBase64(value: string): string {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/').trim();
  return Buffer.from(normalised, 'base64').toString('utf-8');
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${what} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function isAccept(v: unknown): v is X402Accept {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['scheme'] === 'string' &&
    typeof o['network'] === 'string' &&
    typeof o['amount'] === 'string' &&
    typeof o['payTo'] === 'string' &&
    typeof o['asset'] === 'string'
  );
}

/** Decodes the `payment-required` header into the challenge it carries. */
export function decodeChallenge(headerValue: string): X402Challenge {
  const o = parseJsonObject(fromBase64(headerValue), 'x402 challenge');

  const version = o['x402Version'];
  if (typeof version !== 'number') {
    throw new Error('x402 challenge is missing a numeric "x402Version".');
  }
  const accepts = o['accepts'];
  if (!Array.isArray(accepts) || !accepts.every(isAccept)) {
    throw new Error(
      'x402 challenge "accepts" must be a list of {scheme, network, amount, payTo, asset}.',
    );
  }

  return {
    x402Version: version,
    ...(typeof o['error'] === 'string' ? { error: o['error'] } : {}),
    ...(typeof o['resource'] === 'object' && o['resource'] !== null
      ? { resource: o['resource'] as { url?: string } }
      : {}),
    accepts,
  };
}

/** Decodes the `payment-response` header into a settlement receipt. */
export function decodeSettlement(headerValue: string): X402Settlement {
  const o = parseJsonObject(fromBase64(headerValue), 'x402 settlement');
  return {
    ...(typeof o['success'] === 'boolean' ? { success: o['success'] } : {}),
    ...(typeof o['transaction'] === 'string' ? { transaction: o['transaction'] } : {}),
    ...(typeof o['network'] === 'string' ? { network: o['network'] } : {}),
    ...(typeof o['payer'] === 'string' ? { payer: o['payer'] } : {}),
    raw: o,
  };
}

/**
 * What one query is going to cost, read from a 402 we were served.
 *
 * Returns `undefined` for `usd` when the asset is not in {@link KNOWN_ASSETS}:
 * see the note there on why decimals are not guessed.
 */
export interface QuotedPrice {
  readonly network: string;
  readonly asset: string;
  readonly amountRaw: string;
  readonly symbol?: string;
  readonly usd?: number;
}

export function quoteFromChallenge(challenge: X402Challenge): QuotedPrice | undefined {
  const accept = challenge.accepts[0];
  if (!accept) return undefined;
  const known = lookupAsset(accept.network, accept.asset);
  return {
    network: accept.network,
    asset: accept.asset,
    amountRaw: accept.amount,
    ...(known
      ? { symbol: known.symbol, usd: amountToDecimal(accept.amount, known.decimals) }
      : {}),
  };
}
