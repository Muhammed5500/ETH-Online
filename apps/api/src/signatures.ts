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

// ---------------------------------------------------------------- registration

/**
 * Registration authentication.
 *
 * WHAT WAS OPEN AND SHOULD NOT HAVE BEEN. `POST /agents/register` took a
 * public key on trust. Nobody could steal money with that — a bond has to be
 * paid from the account it names, and a report has to be signed by the key it
 * claims — but two things were possible and both are ugly.
 *
 *   Squatting. Register `agent-07` first and the real agent-07 can never use
 *   that name, because identity is fixed at first registration.
 *
 *   Endpoint hijack. Re-registration updates the mutable fields, so anyone
 *   could point a registered agent's endpoint at a server they control. They
 *   still could not produce a valid report, which is worse rather than better:
 *   the victim is drawn, answers nothing, and loses its whole bond.
 *
 * So a registration now has to be signed by the key it registers. That does
 * not make registration permissioned — anyone may still register anything they
 * hold the key for, which is the property PLAN section 3.3 asks for. It makes
 * the claim "this key is mine" checkable instead of assumed.
 *
 * WHY THE MUTABLE FIELDS ARE INSIDE THE SIGNATURE. Signing only the identity
 * would leave a captured signature good forever for re-registration, and the
 * endpoint hijack above would survive. Endpoint and slices are therefore part
 * of the signed bytes, and `issuedAt` bounds how long any of it stays valid.
 */
export const REGISTRATION_SIGNATURE_DOMAIN = 'ethonline-register';
export const REGISTRATION_SIGNATURE_VERSION = 1;

/**
 * How stale a registration may be.
 *
 * Long enough that a slow fleet start or a clock a little off does not fail,
 * short enough that a captured signature is not a standing licence to move an
 * agent's endpoint.
 */
export const REGISTRATION_MAX_AGE_MS = 10 * 60 * 1000;

export interface RegistrationClaim {
  readonly agentId: string;
  readonly accountId: string;
  readonly publicKey: string;
  readonly endpoint?: string;
  readonly sliceIds?: readonly string[];
  /** Unix ms. Bounds replay; see REGISTRATION_MAX_AGE_MS. */
  readonly issuedAt: number;
}

/** The exact bytes a registrant signs. Same pipe-delimited shape as a report. */
export function canonicalRegistrationMessage(claim: RegistrationClaim): string {
  if (!claim.agentId || !claim.accountId || !claim.publicKey) {
    throw new Error('A registration claim needs agentId, accountId and publicKey.');
  }
  if (!Number.isFinite(claim.issuedAt) || claim.issuedAt <= 0) {
    throw new Error(`issuedAt must be a positive unix timestamp, got: ${claim.issuedAt}`);
  }
  return [
    REGISTRATION_SIGNATURE_DOMAIN,
    `v${REGISTRATION_SIGNATURE_VERSION}`,
    claim.agentId,
    claim.accountId,
    claim.publicKey,
    claim.endpoint ?? '',
    // Sorted, so two callers listing the same slices in a different order
    // produce the same bytes and the same signature.
    [...(claim.sliceIds ?? [])].sort().join(','),
    String(Math.trunc(claim.issuedAt)),
  ].join('|');
}

export function registrationMessageBytes(claim: RegistrationClaim): Uint8Array {
  return new Uint8Array(Buffer.from(canonicalRegistrationMessage(claim), 'utf-8'));
}

/**
 * Checks that whoever sent this registration holds the key it registers.
 *
 * The key comes from the claim itself rather than from the registry, which
 * looks circular and is not: what is being proved is possession, not identity.
 * The registry then binds that key to the agent id for good, and the account
 * is bound the first time a bond is paid from it.
 */
export function verifyRegistrationSignature(
  claim: RegistrationClaim,
  signatureHex: string,
  now: number,
  maxAgeMs = REGISTRATION_MAX_AGE_MS,
): { ok: true } | { ok: false; reason: string } {
  const age = now - claim.issuedAt;
  if (age > maxAgeMs) {
    return {
      ok: false,
      reason: `Registration is ${Math.round(age / 1000)}s old; the limit is ${Math.round(maxAgeMs / 1000)}s. Sign a fresh one.`,
    };
  }
  // A little slack the other way: clocks disagree, and refusing a registration
  // because the sender is two seconds ahead helps nobody.
  if (age < -maxAgeMs) {
    return { ok: false, reason: 'Registration is dated in the future.' };
  }

  let message: Uint8Array;
  try {
    message = registrationMessageBytes(claim);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  return verifyBytes(message, signatureHex, claim.publicKey, 'the registration');
}

/**
 * Shared verification for both signature kinds.
 *
 * Hex is validated by hand rather than left to `Buffer.from(s, 'hex')`, which
 * does NOT throw on bad input: it stops at the first invalid character and
 * returns what it managed to read, so a corrupted signature arrives looking
 * short but well-formed and is reported as "does not match" instead of
 * "malformed" — the same-looking outcome with a completely different cause.
 */
function verifyBytes(
  message: Uint8Array,
  signatureHex: string,
  publicKeyDer: string,
  what: string,
): { ok: true } | { ok: false; reason: string } {
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
    return { ok: false, reason: 'Public key could not be parsed.' };
  }

  try {
    if (!publicKey.verify(message, signature)) {
      return { ok: false, reason: `Signature does not match ${what}.` };
    }
  } catch {
    return { ok: false, reason: 'Signature could not be verified against the key.' };
  }
  return { ok: true };
}
