/**
 * Report authentication.
 *
 * Reports are the one write that is NOT paid for, so payment cannot be what
 * proves who sent them. Without a signature anyone could post a report as any
 * agent — and since every agent is scored against the terminal report, forging
 * one is forging the settlement.
 *
 * An agent signs with the same Hedera key it bonds and gets paid with, so
 * "who reported" and "who is on the hook for the bond" are the same identity
 * by construction rather than by bookkeeping.
 *
 * WHAT THE SIGNATURE COVERS, AND WHY EACH PART IS THERE.
 *
 *   marketId   without it, a signature from one market replays into another
 *   agentId    binds the report to the claimed author
 *   position   without it, a report replays at a different point in the
 *              sequence, where it scores against a different previous price
 *   belief     the payload itself
 *
 * Drop any one and the signature stops meaning "this agent said this here".
 */
import { PublicKey } from '@hashgraph/sdk';
import type { Belief } from '@ethonline/core';

export const REPORT_SIGNATURE_DOMAIN = 'ethonline-report';
export const REPORT_SIGNATURE_VERSION = 1;

export interface ReportClaim {
  readonly marketId: string;
  readonly agentId: string;
  readonly position: number;
  readonly belief: Belief;
}

/**
 * The exact bytes an agent signs.
 *
 * A pipe-delimited string rather than JSON: JSON key order and number
 * formatting vary between runtimes, and a signature over bytes that are not
 * reproducible is a signature over nothing. `toFixed(12)` pins the number
 * format so the same belief always yields the same bytes.
 */
export function canonicalReportMessage(claim: ReportClaim): string {
  if (!claim.marketId || !claim.agentId) {
    throw new Error('A report claim needs both marketId and agentId.');
  }
  if (!Number.isInteger(claim.position) || claim.position < 1) {
    throw new Error(`position must be an integer >= 1, got: ${claim.position}`);
  }
  const p1 = claim.belief[1];
  if (!Number.isFinite(p1)) {
    throw new Error(`belief must contain finite numbers, got: ${JSON.stringify(claim.belief)}`);
  }
  return [
    REPORT_SIGNATURE_DOMAIN,
    `v${REPORT_SIGNATURE_VERSION}`,
    claim.marketId,
    claim.agentId,
    String(claim.position),
    p1.toFixed(12),
  ].join('|');
}

export function reportMessageBytes(claim: ReportClaim): Uint8Array {
  return new Uint8Array(Buffer.from(canonicalReportMessage(claim), 'utf-8'));
}

/**
 * Checks a report signature against the agent's registered public key.
 *
 * Returns a reason rather than throwing, because the caller turns this into a
 * 401 with an explanation an agent author can act on.
 */
export function verifyReportSignature(
  claim: ReportClaim,
  signatureHex: string,
  publicKeyDer: string,
): { ok: true } | { ok: false; reason: string } {
  // Hex is validated by hand rather than left to `Buffer.from(s, 'hex')`,
  // which does NOT throw on bad input — it stops at the first invalid
  // character and returns what it managed to read. `abZZ` decodes to a single
  // byte, so a corrupted signature would arrive here looking like a short but
  // well-formed one and be reported as "does not match" instead of "malformed".
  // Same-looking outcome, completely different cause to debug.
  const clean = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
  if (clean.length === 0) return { ok: false, reason: 'Signature is empty.' };
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    return { ok: false, reason: 'Signature is not valid hex.' };
  }
  const signature = new Uint8Array(Buffer.from(clean, 'hex'));

  let publicKey: PublicKey;
  try {
    publicKey = PublicKey.fromString(publicKeyDer);
  } catch {
    return { ok: false, reason: 'Registered public key could not be parsed.' };
  }

  let message: Uint8Array;
  try {
    message = reportMessageBytes(claim);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }

  try {
    if (!publicKey.verify(message, signature)) {
      return { ok: false, reason: 'Signature does not match the report.' };
    }
  } catch {
    return { ok: false, reason: 'Signature could not be verified against the registered key.' };
  }
  return { ok: true };
}
