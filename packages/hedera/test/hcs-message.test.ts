/**
 * HCS message schema tests.
 *
 * Two properties carry weight here:
 *
 *   1. Encoding is canonical. The same message always produces the same bytes,
 *      so a digest over it means something.
 *   2. Nothing exceeds the single-message limit. A report that quietly became
 *      two messages would carry two running hashes, and STEP 14 would have no
 *      single answer to "which hash decided the market".
 */
import { describe, expect, it } from 'vitest';
import {
  assertFitsSingleMessage,
  decodeHcsMessage,
  encodeHcsMessage,
  HCS_MAX_SINGLE_MESSAGE_BYTES,
  messageBytes,
  type HcsMessage,
  type ReportMessage,
  type SettlementMessage,
} from '../src/hcs-message.js';

const report: ReportMessage = {
  v: 1,
  type: 'report',
  marketId: 'mkt-2026-09-10-001',
  ts: 1789000000000,
  position: 3,
  agentId: 'agent-07',
  belief: [0.28, 0.72],
  rawBelief: [0.25, 0.75],
  evidenceDigest: `sha256:${'a'.repeat(64)}`,
};

describe('encodeHcsMessage', () => {
  it('emits fields in a fixed order regardless of object key order', () => {
    const shuffled = {
      evidenceDigest: report.evidenceDigest,
      agentId: report.agentId,
      type: 'report',
      rawBelief: report.rawBelief,
      v: 1,
      ts: report.ts,
      belief: report.belief,
      marketId: report.marketId,
      position: report.position,
    } as unknown as ReportMessage;

    // Canonical encoding is what makes a digest over the message meaningful.
    expect(encodeHcsMessage(shuffled)).toBe(encodeHcsMessage(report));
    expect(encodeHcsMessage(report).indexOf('"v"')).toBeLessThan(
      encodeHcsMessage(report).indexOf('"type"'),
    );
  });

  it('drops absent optional fields rather than writing null', () => {
    const { evidenceDigest: _drop, ...withoutDigest } = report;
    const encoded = encodeHcsMessage(withoutDigest as ReportMessage);
    expect(encoded).not.toContain('evidenceDigest');
    expect(encoded).not.toContain('null');
  });

  it('rejects an unknown message type', () => {
    expect(() => encodeHcsMessage({ type: 'nope' } as unknown as HcsMessage)).toThrow(/Unknown/);
  });
});

describe('round trip', () => {
  it('survives encode then decode for every message type', () => {
    const messages: HcsMessage[] = [
      {
        v: 1,
        type: 'market-open',
        marketId: 'm1',
        ts: 1,
        question: 'Is this protocol growth organic?',
        prior: [0.5, 0.5],
        params: { k: 3, T: 5, alpha: 0.125, epsilon: 0.01, b: 1, R: 0.1 },
      },
      report,
      { v: 1, type: 'timeout', marketId: 'm1', ts: 2, agentId: 'agent-04', position: 4 },
      {
        v: 1,
        type: 'market-close',
        marketId: 'm1',
        ts: 3,
        reason: 'stopping-rule',
        reportCount: 8,
        reference: [0.3, 0.7],
      },
      {
        v: 1,
        type: 'settlement',
        marketId: 'm1',
        ts: 4,
        reference: [0.3, 0.7],
        payouts: [
          ['agent-07', 1, 's', 0.1234],
          ['agent-02', 8, 'f', 0.1],
        ],
        totals: {
          deposit: 0.993,
          totalBonds: 20,
          scoreTotal: 0.42,
          bondsReturned: 20,
          timeoutSlash: 0,
          scoreSlash: 0.05,
          totalToAgents: 20.42,
          askerRefund: 0.573,
        },
      },
    ];

    for (const m of messages) {
      expect(decodeHcsMessage(encodeHcsMessage(m))).toEqual(m);
    }
  });
});

describe('single-message size limit', () => {
  it('a report is comfortably inside the limit', () => {
    expect(messageBytes(encodeHcsMessage(report))).toBeLessThan(HCS_MAX_SINGLE_MESSAGE_BYTES / 2);
  });

  it('a settlement for a full 20-report market still fits in ONE message', () => {
    // The worst realistic case: the pool never stopped early, so every agent
    // reported and every one needs a payout line.
    const payouts = Array.from({ length: 20 }, (_, i) => {
      const kind = i < 17 ? ('s' as const) : ('f' as const);
      return [`agent-${String(i + 1).padStart(2, '0')}`, i + 1, kind, -0.123456789] as const;
    });
    const settlement: SettlementMessage = {
      v: 1,
      type: 'settlement',
      marketId: 'mkt-2026-09-10-001',
      ts: 1789000000000,
      reference: [0.283456, 0.716544],
      payouts,
      totals: {
        deposit: 0.9931471805599453,
        totalBonds: 20,
        scoreTotal: 0.4212345678,
        bondsReturned: 20,
        timeoutSlash: 0,
        scoreSlash: 0.0512345678,
        totalToAgents: 20.4212345678,
        askerRefund: 0.5731234567,
      },
    };
    const encoded = encodeHcsMessage(settlement);
    expect(() => assertFitsSingleMessage(encoded)).not.toThrow();
    expect(messageBytes(encoded)).toBeLessThanOrEqual(HCS_MAX_SINGLE_MESSAGE_BYTES);
  });

  it('refuses an oversized message loudly instead of letting it split', () => {
    const huge: ReportMessage = { ...report, marketId: 'x'.repeat(1100) };
    expect(() => assertFitsSingleMessage(encodeHcsMessage(huge))).toThrow(/single-message/);
    expect(() => assertFitsSingleMessage(encodeHcsMessage(huge))).toThrow(/running hashes/);
  });

  it('counts UTF-8 bytes, not characters', () => {
    // A Turkish question would otherwise be measured short and slip past.
    expect(messageBytes('ğüşiöç')).toBeGreaterThan('ğüşiöç'.length);
  });
});

describe('decodeHcsMessage validation', () => {
  it('rejects malformed JSON', () => {
    expect(() => decodeHcsMessage('{ nope')).toThrow(/not valid JSON/);
  });

  it('rejects a version it does not understand', () => {
    expect(() => decodeHcsMessage(JSON.stringify({ ...report, v: 2 }))).toThrow(/version/);
  });

  it('rejects an unknown type', () => {
    expect(() => decodeHcsMessage(JSON.stringify({ ...report, type: 'gossip' }))).toThrow(/Unknown/);
  });

  it('requires a marketId and a numeric ts on every type', () => {
    expect(() => decodeHcsMessage(JSON.stringify({ ...report, marketId: '' }))).toThrow(/marketId/);
    expect(() => decodeHcsMessage(JSON.stringify({ ...report, ts: 'now' }))).toThrow(/ts/);
  });

  it('rejects a report with a malformed belief', () => {
    expect(() => decodeHcsMessage(JSON.stringify({ ...report, belief: [0.3] }))).toThrow(/belief/);
    expect(() => decodeHcsMessage(JSON.stringify({ ...report, rawBelief: 'x' }))).toThrow(/rawBelief/);
  });

  it('rejects a report at position zero', () => {
    expect(() => decodeHcsMessage(JSON.stringify({ ...report, position: 0 }))).toThrow(/position/);
  });

  it('rejects a market-close with an invented reason', () => {
    const close = { v: 1, type: 'market-close', marketId: 'm', ts: 1, reason: 'vibes', reportCount: 2 };
    expect(() => decodeHcsMessage(JSON.stringify(close))).toThrow(/reason/);
  });

  it('rejects settlement payouts that are not proper tuples', () => {
    const bad = {
      v: 1,
      type: 'settlement',
      marketId: 'm',
      ts: 1,
      payouts: [{ agentId: 'a', amount: 1 }],
      totals: {},
    };
    expect(() => decodeHcsMessage(JSON.stringify(bad))).toThrow(/tuples/);
  });

  it('rejects a top-level array', () => {
    expect(() => decodeHcsMessage('[]')).toThrow(/must be a JSON object/);
  });
});
