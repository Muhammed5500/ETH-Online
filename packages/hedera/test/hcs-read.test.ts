/**
 * Mirror node reading tests — no network.
 *
 * `parseMirrorMessages` is pure and `readTopicMessages` takes an injected
 * fetch, so the whole read path including pagination is covered here. The real
 * round trip against testnet is the STEP 13 manual gate.
 */
import { describe, expect, it, vi } from 'vitest';
import { encodeHcsMessage, type ReportMessage } from '../src/hcs-message.js';
import { mirrorNodeUrl, parseMirrorMessages, readTopicMessages } from '../src/hcs-read.js';

function reportAt(position: number): ReportMessage {
  return {
    v: 1,
    type: 'report',
    marketId: 'm1',
    ts: 1789000000000 + position,
    position,
    agentId: `agent-${String(position).padStart(2, '0')}`,
    belief: [0.4, 0.6],
    rawBelief: [0.4, 0.6],
  };
}

/** Mirror node returns base64 for both the payload and the running hash. */
function mirrorEntry(position: number) {
  return {
    consensus_timestamp: `178900000${position}.000000001`,
    message: Buffer.from(encodeHcsMessage(reportAt(position)), 'utf-8').toString('base64'),
    running_hash: Buffer.from(new Uint8Array(48).fill(position)).toString('base64'),
    running_hash_version: 3,
    sequence_number: position,
    topic_id: '0.0.5555',
  };
}

describe('mirrorNodeUrl', () => {
  it('points at the right host per network', () => {
    expect(mirrorNodeUrl('testnet')).toContain('testnet.mirrornode');
    expect(mirrorNodeUrl('mainnet')).toContain('mainnet-public.mirrornode');
    expect(mirrorNodeUrl('previewnet')).toContain('previewnet.mirrornode');
    expect(mirrorNodeUrl('local')).toContain('localhost');
  });
});

describe('parseMirrorMessages', () => {
  it('decodes base64 payloads and running hashes', () => {
    const entries = parseMirrorMessages({ messages: [mirrorEntry(1), mirrorEntry(2)] });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.sequenceNumber).toBe(1);
    expect(entries[0]?.message?.type).toBe('report');
    expect(entries[0]?.runningHash).toHaveLength(48);
    expect(entries[1]?.message).toMatchObject({ position: 2, agentId: 'agent-02' });
  });

  it('preserves consensus order as the mirror node returned it', () => {
    const entries = parseMirrorMessages({
      messages: [mirrorEntry(1), mirrorEntry(2), mirrorEntry(3)],
    });
    expect(entries.map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);
  });

  it('reports a foreign message instead of dropping it or throwing', () => {
    // A topic is public data. If the submit key were ever absent, anything
    // could be in there; the reader's job is to say exactly what is present.
    const foreign = {
      consensus_timestamp: '1789000009.000000001',
      message: Buffer.from('not our schema at all', 'utf-8').toString('base64'),
      running_hash: Buffer.from(new Uint8Array(48)).toString('base64'),
      sequence_number: 9,
    };
    const entries = parseMirrorMessages({ messages: [mirrorEntry(1), foreign] });
    expect(entries).toHaveLength(2);
    expect(entries[1]?.message).toBeUndefined();
    expect(entries[1]?.parseError).toMatch(/not valid JSON/);
    expect(entries[1]?.raw).toBe('not our schema at all');
  });

  it('rejects a response that is not shaped like a mirror node page', () => {
    expect(() => parseMirrorMessages(null)).toThrow(/not an object/);
    expect(() => parseMirrorMessages({})).toThrow(/messages/);
  });

  it('handles an empty topic', () => {
    expect(parseMirrorMessages({ messages: [] })).toEqual([]);
  });
});

describe('readTopicMessages', () => {
  function fakeFetch(pages: ReadonlyArray<{ messages: unknown[]; links?: { next?: string | null } }>) {
    let call = 0;
    // The url parameter is declared so `mock.calls[0][0]` stays typed — the
    // assertions below check which url was requested.
    return vi.fn(async (input: string | URL | Request): Promise<Response> => {
      void input;
      const page = pages[call++];
      return {
        ok: true,
        status: 200,
        json: async () => page,
        text: async () => JSON.stringify(page),
      } as unknown as Response;
    });
  }

  it('follows pagination until there is no next link', () => {
    const fetchImpl = fakeFetch([
      { messages: [mirrorEntry(1), mirrorEntry(2)], links: { next: '/api/v1/page2' } },
      { messages: [mirrorEntry(3)], links: { next: null } },
    ]);
    return readTopicMessages('testnet', '0.0.5555', { fetchImpl }).then((entries) => {
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(entries.map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);
    });
  });

  it('asks for ascending order so the ledger reads front to back', async () => {
    const fetchImpl = fakeFetch([{ messages: [], links: { next: null } }]);
    await readTopicMessages('testnet', '0.0.5555', { fetchImpl });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('order=asc');
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/topics/0.0.5555/messages');
  });

  it('stops at maxMessages so a runaway topic cannot exhaust memory', async () => {
    const fetchImpl = fakeFetch([
      { messages: [mirrorEntry(1), mirrorEntry(2), mirrorEntry(3)], links: { next: '/next' } },
      { messages: [mirrorEntry(4)], links: { next: null } },
    ]);
    const entries = await readTopicMessages('testnet', '0.0.5555', { fetchImpl, maxMessages: 2 });
    expect(entries).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces an HTTP error rather than returning an empty ledger', async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request): Promise<Response> => {
        void input;
        return {
          ok: false,
          status: 404,
          text: async () => 'Not found',
          json: async () => ({}),
        } as unknown as Response;
      },
    );
    await expect(readTopicMessages('testnet', '0.0.9999', { fetchImpl })).rejects.toThrow(/404/);
  });
});

describe('transient network failures', () => {
  const noSleep = async (): Promise<void> => {};

  it('retries a dropped connection — the read is idempotent, so a repeat is free', async () => {
    // Seen for real in STEP 16: a bare `fetch failed` from a momentary hiccup
    // killed a verification run that had nothing wrong with it.
    let calls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      void input;
      if (++calls < 3) throw new Error('fetch failed');
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [mirrorEntry(1)], links: { next: null } }),
        text: async () => '',
      } as unknown as Response;
    });

    const entries = await readTopicMessages('testnet', '0.0.5555', { fetchImpl, sleep: noSleep });
    expect(entries).toHaveLength(1);
    expect(calls).toBe(3);
  });

  it('does NOT retry an HTTP status — 404 is an answer, not a glitch', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      void input;
      calls++;
      return {
        ok: false,
        status: 404,
        text: async () => 'Not found',
        json: async () => ({}),
      } as unknown as Response;
    });

    await expect(
      readTopicMessages('testnet', '0.0.9999', { fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it('gives up after the attempt budget', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      void input;
      throw new Error('fetch failed');
    });
    await expect(
      readTopicMessages('testnet', '0.0.5555', { fetchImpl, attempts: 2, sleep: noSleep }),
    ).rejects.toThrow(/fetch failed/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
