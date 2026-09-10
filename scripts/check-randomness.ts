/**
 * Runs a real market on testnet with the stopping rule driven by HCS — the
 * STEP 14 gate.
 *
 * This is not a test of hash arithmetic; the unit tests cover that. It plugs
 * `HcsRandomSource` into the actual `Market` from `core` and lets consensus
 * decide when the market closes. Every draw and every stopping roll comes from
 * a running hash that did not exist until the previous message reached
 * consensus.
 *
 * Then it does the thing that matters: re-derives every decision using ONLY
 * what the mirror node serves publicly, and shows that a fabricated claim is
 * caught.
 *
 * It is also a small dry run of the STEP 16 orchestrator loop, so if the
 * interfaces do not fit together, we find out now rather than on day 6.
 *
 * Run:  pnpm check:randomness
 */
import './load-env.js';
import {
  beliefFromProbability,
  DEFAULT_PARAMS,
  Market,
  UNIFORM_PRIOR,
  type Belief,
} from '@ethonline/core';
import {
  createHederaClient,
  createMarketTopic,
  hashToUnitInterval,
  hashscanUrl,
  HcsRandomSource,
  hederaConfigFromEnv,
  readTopicMessages,
  submitMessage,
  toHex,
  verifyStoppingDecision,
  type HcsMessage,
} from '@ethonline/hedera';

let failures = 0;

function step(ok: boolean, name: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) console.log(`         ${detail}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Stand-in agent: nudges the price toward its own number. Chain-free. */
function beliefFor(agentId: string, price: Belief): Belief {
  const signal = 0.4 + ((agentId.charCodeAt(agentId.length - 1) * 7) % 45) / 100;
  return beliefFromProbability(0.6 * price[1] + 0.4 * signal);
}

async function main(): Promise<void> {
  console.log('\nHCS STOPPING RULE CHECK\n' + '='.repeat(72));

  const cfg = hederaConfigFromEnv();
  const marketId = `rnd-${Date.now()}`;
  const params = DEFAULT_PARAMS;
  const client = createHederaClient(cfg);

  /** What we claim happened, to be rechecked from public data at the end. */
  const rolls: Array<{ position: number; hashHex: string; u: number; stopped: boolean }> = [];

  try {
    const { topicId } = await createMarketTopic(client, { memo: `ethonline randomness ${marketId}` });
    console.log(`  Topic: ${topicId}\n`);

    // --- open the market and seed the randomness source ------------------
    const open: HcsMessage = {
      v: 1,
      type: 'market-open',
      marketId,
      ts: Date.now(),
      question: 'Is this protocol growth organic?',
      prior: UNIFORM_PRIOR,
      params: {
        k: params.k,
        T: params.T,
        alpha: params.alpha,
        epsilon: params.epsilon,
        b: params.b,
        R: params.R,
      },
    };
    const openResult = await submitMessage(client, topicId, open);

    // The source starts empty on purpose: no decision may be drawn before the
    // opening message has reached consensus.
    const rng = new HcsRandomSource();
    rng.update(openResult.runningHash);

    const market = Market.create(
      { id: marketId, question: open.question, params, prior: UNIFORM_PRIOR },
      rng,
    );
    for (let i = 1; i <= params.minPoolSize; i++) {
      market.addBondedAgent(`agent-${String(i).padStart(2, '0')}`);
    }
    market.closeBonding();
    step(market.status === 'running', 'Market opened with a bonded pool', `${params.minPoolSize} agents`);

    // --- the STEP 16 loop, in miniature ----------------------------------
    console.log('\n  Running rounds — consensus decides when this stops.\n');

    while (market.status === 'running') {
      const agentId = market.drawNextAgent();
      if (agentId === null) break;

      const position = market.reportCount + 1;
      const report = market.submitReport(agentId, beliefFor(agentId, market.currentPrice()));

      const res = await submitMessage(client, topicId, {
        v: 1,
        type: 'report',
        marketId,
        ts: Date.now(),
        position: report.position,
        agentId,
        belief: report.belief,
        rawBelief: report.rawBelief,
      });

      // Order matters: the dice must be rolled on the hash of the report that
      // was just written, so nobody could have known it in advance.
      rng.update(res.runningHash);
      const stopped = market.rollStoppingDice();

      const u = hashToUnitInterval(res.runningHash, 'stop');
      rolls.push({ position, hashHex: toHex(res.runningHash), u, stopped });

      console.log(
        `    #${String(position).padStart(2)}  ${agentId}  p=${report.belief[1].toFixed(3)}  ` +
          `u=${u.toFixed(6)}  ${stopped ? 'CLOSE' : 'continue'}`,
      );
    }

    const state = market.getState();
    await submitMessage(client, topicId, {
      v: 1,
      type: 'market-close',
      marketId,
      ts: Date.now(),
      reason: state.closedReason ?? 'stopping-rule',
      reportCount: state.reports.length,
      ...(state.referenceReport ? { reference: state.referenceReport.belief } : {}),
    });

    console.log('');
    step(market.status === 'closed', 'Market closed', `after ${state.reports.length} reports, reason: ${state.closedReason}`);
    step(
      rolls.filter((r) => r.stopped).length === (state.closedReason === 'stopping-rule' ? 1 : 0),
      'Exactly one roll closed the market',
    );
    step(
      rolls.slice(0, -1).every((r) => !r.stopped),
      'No roll before the last one asked to close',
    );

    // Draws and stops must not have shared bytes.
    const stopValues = rng.draws.filter((d) => d.purpose === 'stop').map((d) => d.value);
    const drawValues = rng.draws.filter((d) => d.purpose === 'draw').map((d) => d.value);
    step(
      stopValues.every((v) => !drawValues.includes(v)),
      'No stopping value was reused as a draw value',
      `${stopValues.length} stops, ${drawValues.length} draws`,
    );
    step(
      new Set(state.reports.map((r) => r.agentId)).size === state.reports.length,
      'No agent was drawn twice',
    );

    // --- independent verification, mirror node only ----------------------
    console.log('\n  Re-deriving every decision from public mirror data ...');

    let entries: Awaited<ReturnType<typeof readTopicMessages>> = [];
    const expected = rolls.length + 2;
    for (let attempt = 1; attempt <= 12; attempt++) {
      await sleep(2500);
      entries = await readTopicMessages(cfg.network, topicId);
      if (entries.length >= expected) break;
    }
    console.log('');

    step(entries.length === expected, `Ledger complete: ${expected} messages`, `got ${entries.length}`);

    const publicReports = entries.filter((e) => e.message?.type === 'report');
    step(publicReports.length === rolls.length, 'Every report is public');

    const hashesMatch = publicReports.every((e, i) => toHex(e.runningHash) === rolls[i]?.hashHex);
    step(hashesMatch, 'Public running hashes are byte-identical to what we acted on');

    const allVerified = publicReports.every((e, i) =>
      verifyStoppingDecision(e.runningHash, params.alpha, rolls[i]!.stopped),
    );
    step(allVerified, 'Every stopping decision re-derives correctly from public data');

    // The point of the exercise: a lie is detectable.
    const lastRoll = rolls[rolls.length - 1]!;
    const lastEntry = publicReports[publicReports.length - 1]!;
    step(
      verifyStoppingDecision(lastEntry.runningHash, params.alpha, !lastRoll.stopped) === false,
      'A fabricated claim about the closing roll is caught',
      'an orchestrator cannot close early or run long without it showing',
    );

    console.log('\n' + '='.repeat(72));
    console.log(`  Topic:    ${topicId}`);
    console.log(`  HashScan: ${hashscanUrl(cfg.network, 'topic', topicId)}`);
    console.log(`  Reports:  ${state.reports.length}   alpha=${params.alpha}   E[length]=${1 / params.alpha}`);
    console.log('='.repeat(72));
  } finally {
    client.close();
  }

  console.log('');
  if (failures === 0) {
    console.log('STOPPING RULE OK — driven by consensus, checkable by anyone.\n');
  } else {
    console.log(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n  Check failed:', e instanceof Error ? e.message : e, '\n');
  process.exit(1);
});
