/**
 * End-to-end exercise of the HCS report ledger — the STEP 13 gate.
 *
 * Creates a real topic, writes a small market's worth of messages, then reads
 * the whole thing back through the mirror node and checks that what comes out
 * is what went in, in the order it went in.
 *
 * The read side deliberately uses only HTTP, no SDK: that is the audit-trail
 * claim being demonstrated, not just tested. Anyone can do what this script
 * does to the second half of a real market.
 *
 * NOTE: topics are created without an admin key, so they are permanent. Every
 * run leaves one behind on testnet. That is the intended trade.
 *
 * Run:  pnpm check:hcs
 */
import './load-env.js';
import {
  createHederaClient,
  createMarketTopic,
  encodeHcsMessage,
  hashscanUrl,
  hederaConfigFromEnv,
  messageBytes,
  readTopicMessages,
  submitMessage,
  type HcsMessage,
} from '@ethonline/hedera';

let failures = 0;

function step(ok: boolean, name: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) console.log(`         ${detail}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log('\nHCS REPORT LEDGER CHECK\n' + '='.repeat(70));

  const cfg = hederaConfigFromEnv();
  const marketId = `check-${Date.now()}`;
  const client = createHederaClient(cfg);

  try {
    // ---- topic ---------------------------------------------------------
    const { topicId } = await createMarketTopic(client, {
      memo: `ethonline ledger check ${marketId}`,
    });
    step(true, 'Topic created (no admin key, so it is permanent)', topicId);

    // ---- one small market ---------------------------------------------
    const messages: HcsMessage[] = [
      {
        v: 1,
        type: 'market-open',
        marketId,
        ts: Date.now(),
        question: 'Is this protocol growth organic?',
        prior: [0.5, 0.5],
        params: { k: 3, T: 5, alpha: 0.125, epsilon: 0.01, b: 1, R: 0.1 },
      },
      {
        v: 1,
        type: 'report',
        marketId,
        ts: Date.now(),
        position: 1,
        agentId: 'agent-01',
        belief: [0.35, 0.65],
        rawBelief: [0.3, 0.7],
      },
      {
        v: 1,
        type: 'report',
        marketId,
        ts: Date.now(),
        position: 2,
        agentId: 'agent-02',
        belief: [0.28, 0.72],
        rawBelief: [0.28, 0.72],
      },
      {
        v: 1,
        type: 'market-close',
        marketId,
        ts: Date.now(),
        reason: 'stopping-rule',
        reportCount: 2,
        reference: [0.28, 0.72],
      },
    ];

    console.log('\n  Writing messages ...\n');
    const written: Array<{ seq: number; hash: string; ts: string }> = [];

    for (const m of messages) {
      const res = await submitMessage(client, topicId, m);
      written.push({
        seq: res.sequenceNumber,
        hash: Buffer.from(res.runningHash).toString('hex'),
        ts: res.consensusTimestamp,
      });
      console.log(
        `    #${res.sequenceNumber}  ${m.type.padEnd(13)} ${String(res.bytes).padStart(4)} bytes  ` +
          `hash ${Buffer.from(res.runningHash).toString('hex').slice(0, 16)}...`,
      );
    }

    console.log('');
    step(
      written.every((w, i) => w.seq === i + 1),
      'Sequence numbers are 1..n with no gaps',
      `got ${written.map((w) => w.seq).join(', ')}`,
    );

    const hashLengths = new Set(written.map((w) => w.hash.length / 2));
    step(
      hashLengths.size === 1 && hashLengths.has(48),
      'Every running hash is 48 bytes',
      `lengths: ${[...hashLengths].join(', ')}`,
    );

    step(
      new Set(written.map((w) => w.hash)).size === written.length,
      'Every running hash is distinct — STEP 14 needs fresh entropy per report',
    );

    step(
      written.every((w) => w.ts.includes('.')),
      'Consensus timestamps returned',
      written[0]?.ts ?? '',
    );

    const oversize = messages.filter((m) => messageBytes(encodeHcsMessage(m)) > 1024);
    step(oversize.length === 0, 'No message needed chunking — one message, one hash');

    // ---- read it back, HTTP only ---------------------------------------
    console.log('\n  Reading back through the mirror node (a few seconds of lag) ...');

    let entries: Awaited<ReturnType<typeof readTopicMessages>> = [];
    for (let attempt = 1; attempt <= 12; attempt++) {
      await sleep(2500);
      entries = await readTopicMessages(cfg.network, topicId);
      if (entries.length >= messages.length) break;
      process.stdout.write(`    attempt ${attempt}: ${entries.length}/${messages.length}\n`);
    }
    console.log('');

    step(
      entries.length === messages.length,
      `All ${messages.length} messages readable`,
      `got ${entries.length}`,
    );

    step(
      entries.every((e) => e.parseError === undefined),
      'Every message parsed against the schema',
      entries.find((e) => e.parseError)?.parseError ?? '',
    );

    step(
      entries.map((e) => e.sequenceNumber).join(',') ===
        messages.map((_, i) => i + 1).join(','),
      'Order preserved end to end',
      entries.map((e) => e.sequenceNumber).join(', '),
    );

    step(
      entries.map((e) => e.message?.type).join(',') === messages.map((m) => m.type).join(','),
      'Message types came back in the order they were written',
      entries.map((e) => e.message?.type).join(' -> '),
    );

    const writtenHashes = written.map((w) => w.hash);
    const readHashes = entries.map((e) => Buffer.from(e.runningHash).toString('hex'));
    step(
      writtenHashes.join(',') === readHashes.join(','),
      'Running hashes from the receipt match the mirror node',
      'the value STEP 14 uses is independently verifiable',
    );

    const reports = entries.filter((e) => e.message?.type === 'report');
    step(reports.length === 2, 'Both reports are on the ledger');
    const first = reports[0]?.message;
    step(
      first?.type === 'report' && first.belief[1] === 0.65 && first.rawBelief[1] === 0.7,
      'Clipped and raw beliefs both survive the round trip',
      'the clip stays auditable',
    );

    console.log('\n' + '='.repeat(70));
    console.log(`  Topic:    ${topicId}`);
    console.log(`  HashScan: ${hashscanUrl(cfg.network, 'topic', topicId)}`);
    console.log('='.repeat(70));
  } finally {
    client.close();
  }

  console.log('');
  if (failures === 0) {
    console.log('LEDGER OK — ordered, immutable, and readable without the SDK.\n');
  } else {
    console.log(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n  Check failed:', e instanceof Error ? e.message : e, '\n');
  process.exit(1);
});
