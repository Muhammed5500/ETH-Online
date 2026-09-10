/**
 * Report signature tests.
 *
 * Reports are the one unpaid write, so this signature is the only thing
 * standing between an agent's identity and anyone who wants to use it. The
 * replay cases below are the point of the file: a signature that is valid for
 * the wrong market, the wrong agent or the wrong position would let a real
 * signature be reused where it does not belong, and every agent is scored
 * against the terminal report.
 */
import { describe, expect, it } from 'vitest';
import { beliefFromProbability } from '@ethonline/core';
import {
  canonicalReportMessage,
  REPORT_SIGNATURE_DOMAIN,
  verifyReportSignature,
  type ReportClaim,
} from '../src/signatures.js';
import { makeTestAgent } from './helpers.js';

const agent = makeTestAgent('agent-07');

const claim: ReportClaim = {
  marketId: 'mkt-2026-09-10-001',
  agentId: 'agent-07',
  position: 3,
  belief: beliefFromProbability(0.72),
};

describe('canonicalReportMessage', () => {
  it('is stable and contains every field that must be bound', () => {
    const msg = canonicalReportMessage(claim);
    expect(msg).toBe(`${REPORT_SIGNATURE_DOMAIN}|v1|mkt-2026-09-10-001|agent-07|3|0.720000000000`);
    expect(canonicalReportMessage(claim)).toBe(msg);
  });

  it('pins the number format so the bytes are reproducible', () => {
    // 0.1 + 0.2 does not print as 0.3; a signature over unreproducible bytes
    // is a signature over nothing.
    const a = canonicalReportMessage({ ...claim, belief: beliefFromProbability(0.1 + 0.2) });
    const b = canonicalReportMessage({ ...claim, belief: beliefFromProbability(0.3) });
    expect(a).toBe(b);
  });

  it('rejects an incomplete claim', () => {
    expect(() => canonicalReportMessage({ ...claim, marketId: '' })).toThrow(/marketId/);
    expect(() => canonicalReportMessage({ ...claim, position: 0 })).toThrow(/position/);
    expect(() => canonicalReportMessage({ ...claim, belief: [0.5, Number.NaN] })).toThrow(/finite/);
  });
});

describe('verifyReportSignature', () => {
  it('accepts a genuine signature', () => {
    expect(verifyReportSignature(claim, agent.sign(claim), agent.publicKey)).toEqual({ ok: true });
  });

  it('accepts a 0x-prefixed signature', () => {
    const sig = `0x${agent.sign(claim)}`;
    expect(verifyReportSignature(claim, sig, agent.publicKey).ok).toBe(true);
  });

  it('REJECTS a signature replayed into another market', () => {
    const sig = agent.sign(claim);
    const other = { ...claim, marketId: 'mkt-2026-09-10-002' };
    expect(verifyReportSignature(other, sig, agent.publicKey).ok).toBe(false);
  });

  it('REJECTS a signature replayed at another position', () => {
    // Position matters: the same belief at a different point in the sequence
    // scores against a different previous price.
    const sig = agent.sign(claim);
    expect(verifyReportSignature({ ...claim, position: 4 }, sig, agent.publicKey).ok).toBe(false);
  });

  it('REJECTS a signature reattributed to another agent', () => {
    const sig = agent.sign(claim);
    expect(verifyReportSignature({ ...claim, agentId: 'agent-08' }, sig, agent.publicKey).ok).toBe(
      false,
    );
  });

  it('REJECTS a tampered probability', () => {
    const sig = agent.sign(claim);
    const tampered = { ...claim, belief: beliefFromProbability(0.9) };
    expect(verifyReportSignature(tampered, sig, agent.publicKey).ok).toBe(false);
  });

  it('REJECTS a signature from a different key', () => {
    const impostor = makeTestAgent('agent-07', 2);
    expect(verifyReportSignature(claim, impostor.sign(claim), agent.publicKey).ok).toBe(false);
  });

  it('explains malformed input rather than throwing', () => {
    expect(verifyReportSignature(claim, 'nothex', agent.publicKey)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/hex/),
    });
    expect(verifyReportSignature(claim, '', agent.publicKey).ok).toBe(false);
    expect(verifyReportSignature(claim, agent.sign(claim), 'not-a-key')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/public key/),
    });
  });
});

describe('malformed hex is rejected as malformed', () => {
  it('does not let Node silently truncate a corrupted signature', () => {
    // `Buffer.from('abZZ', 'hex')` returns one byte rather than throwing. Left
    // to it, a corrupted signature would reach verification looking merely
    // short, and the failure would read "does not match the report" — the
    // wrong diagnosis for an agent author trying to fix their client.
    expect(Buffer.from('abZZ', 'hex')).toHaveLength(1);

    const result = verifyReportSignature(claim, 'abZZ', agent.publicKey);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/valid hex/) });
  });

  it('rejects an odd-length signature', () => {
    expect(verifyReportSignature(claim, 'abc', agent.publicKey)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/valid hex/),
    });
  });

  it('a real signature with one character corrupted is still refused', () => {
    const sig = agent.sign(claim);
    const corrupted = `Z${sig.slice(1)}`;
    expect(verifyReportSignature(claim, corrupted, agent.publicKey).ok).toBe(false);
  });
});
