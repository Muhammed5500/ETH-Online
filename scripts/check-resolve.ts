/**
 * End-to-end proof for the resolution service — the STEP 22 gate.
 *
 * WHAT THIS RUNS THAT NOTHING ELSE DOES. The unit tests cover the route with a
 * fake transport. The demo server runs a market with a scripted transport in
 * the same process. Neither one ever sends an HTTP request to a separate agent
 * process holding its own Hedera key and its own Graph budget — and that is
 * the only configuration that ships.
 *
 * So this script drives the real thing:
 *
 *   1. POST /resolve for a question nobody has asked  -> 202, a market opened
 *   2. every registered agent posts its bond
 *   3. the orchestrator runs the market over HTTP against the live fleet
 *   4. settlement
 *   5. POST /resolve for the SAME question            -> 200, the answer
 *
 * Step 5 is the one that matters. The service sold nothing at step 1 because
 * the mechanism had not produced anything yet, and it sells a real terminal
 * report at step 5 because it has. A service that answered at step 1 would be
 * selling a guess.
 *
 * WHAT IS REAL AND WHAT IS NOT. Real: the agents (separate processes, real
 * keys, real signatures), the mechanism, the draws and the stopping dice, the
 * settlement arithmetic and its invariants, and — unless `--offline` — the
 * models and the Graph queries the agents pay for. Not real: the ledger (a
 * Map, not HCS) and the payer (records transfers instead of sending them).
 * Chain-level proof is STEP 17's job and was done on testnet.
 *
 * Run:  pnpm agents --offline        (in one terminal)
 *       pnpm check:resolve           (in another)
 */
import './load-env.js';
import {
  createApp,
  createMemoryLedger,
  Orchestrator,
  httpAgentTransport,
  type Payer,
  type PayerReceipt,
} from '@ethonline/api';

const PORT = Number(process.env['RESOLVE_PORT'] ?? 4021);
const BASE = `http://127.0.0.1:${PORT}`;
const QUESTION =
  process.env['RESOLVE_QUESTION'] ??
  `Is Curve liquidity growth organic over the last 30 days? (run ${Date.now()})`;

let failures = 0;

function step(ok: boolean, name: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) console.log(`         ${detail}`);
}

function note(text: string): void {
  console.log(`         ${text}`);
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep the raw text — a non-JSON body is itself the finding */
  }
  return { status: res.status, body: parsed as any };
}

/** Records transfers instead of sending them. STEP 17 covers the chain. */
function recordingPayer(log: Array<{ memo: string; total: bigint }>): Payer {
  return {
    async send(lines, memo): Promise<PayerReceipt> {
      const total = lines.reduce((s, l) => s + l.amountTinybar, 0n);
      log.push({ memo, total });
      return { transactionId: `0.0.9@${log.length}.000000001`, status: 'SUCCESS' };
    },
  };
}

async function main(): Promise<void> {
  const ledger = createMemoryLedger({ topicSeed: 980000 });
  const { app, registry, markets, config } = createApp({ ledger });
  const transfers: Array<{ memo: string; total: bigint }> = [];

  const server = app.listen(PORT);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });

  console.log('\nRESOLUTION SERVICE CHECK (STEP 22)');
  console.log('='.repeat(72));
  console.log(`  API       ${BASE}`);
  console.log(`  Question  ${QUESTION}`);
  console.log('='.repeat(72));

  try {
    // ---- 0. the fleet has to be up ------------------------------------
    console.log('\n0. THE FLEET\n' + '-'.repeat(72));

    // The ordering here is the wrong way round if taken literally: the fleet
    // registers against this port, so it cannot register until this server is
    // listening — but this script cannot check the registry until the fleet
    // has. So it waits rather than asserting on an empty registry, which would
    // just be a race the script always lost.
    const want = Number(process.env['AGENT_COUNT'] ?? 20);
    const deadline = Date.now() + Number(process.env['FLEET_WAIT_MS'] ?? 90_000);
    if (registry.size < want) {
      console.log(`         waiting for ${want} agents to register (Ctrl-C to give up)...`);
      while (registry.size < want && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (registry.size === 0) {
      step(false, 'Agents are registered', 'None. Start the fleet first: pnpm agents --offline');
      note('The fleet registers itself against API_URL, which defaults to this port.');
      return;
    }
    step(true, `${registry.size} agents registered`, registry.list().map((a) => a.agentId).join(', '));

    const withoutEndpoint = registry.list().filter((a) => !a.endpoint);
    step(
      withoutEndpoint.length === 0,
      'Every agent published an endpoint',
      withoutEndpoint.length > 0 ? `missing: ${withoutEndpoint.map((a) => a.agentId).join(', ')}` : '',
    );

    // ---- 1. an unanswered question is NOT answered ---------------------
    console.log('\n1. AN UNANSWERED QUESTION\n' + '-'.repeat(72));
    const first = await post('/resolve', { question: QUESTION });
    step(first.status === 202, `Answers 202, not a guess (HTTP ${first.status})`);
    step(first.body?.status === 'opened', `Opened a market`, `marketId ${first.body?.marketId}`);
    const marketId: string = first.body?.marketId;
    if (!marketId) return;
    note(`topic ${first.body?.topicId}`);

    // ---- 2. asking again must NOT open a second market -----------------
    const again = await post('/resolve', { question: `  ${QUESTION.toUpperCase()}  ` });
    step(
      again.body?.status === 'pending' && again.body?.marketId === marketId,
      'Asking again points at the same market, never a second one',
      `status ${again.body?.status}, marketId ${again.body?.marketId}`,
    );

    // ---- 3. the pool bonds --------------------------------------------
    console.log('\n2. BONDING\n' + '-'.repeat(72));
    let bonded = 0;
    for (const agent of registry.list()) {
      const res = await post(`/market/${marketId}/bond`, { agentId: agent.agentId });
      if (res.status === 201) bonded++;
    }
    const stored = markets.get(marketId)!;
    step(
      bonded >= stored.params.minPoolSize,
      `${bonded} agents bonded (minimum ${stored.params.minPoolSize})`,
    );
    if (bonded < stored.params.minPoolSize) {
      note('Run the fleet with at least as many agents as minPoolSize.');
      return;
    }

    // ---- 4. run it over HTTP against the live agents -------------------
    console.log('\n3. THE MARKET, OVER HTTP\n' + '-'.repeat(72));
    const orchestrator = new Orchestrator({
      markets,
      registry,
      ledger,
      transport: httpAgentTransport(),
      payer: recordingPayer(transfers),
      hbarPerUnit: config.hbarPerUnit,
      maxCreditsPerTransaction: 9,
      // The orchestrator's default is sixty seconds, which is generous for a
      // stub and tight for the real thing: an agent holding three slices runs
      // three Graph queries and then waits on a model whose own timeout is
      // forty-five. Leaving it at sixty would make a slow query look like a
      // silent agent — and a silent agent loses its entire bond. The penalty
      // for being slow has to be the mechanism's, not the stopwatch's.
      reportTimeoutMs: Number(process.env['REPORT_TIMEOUT_MS'] ?? 120_000),
    });

    const started = Date.now();
    const opened = await orchestrator.closeBonding(marketId);
    step(opened === 'running', `Bonding closed, market is ${opened}`);
    if (opened !== 'running') {
      note('The pool did not reach minPoolSize, so the market was cancelled and refunded.');
      return;
    }

    // `runMarket` returns the final MarketState, not a list of rounds: it owns
    // the loop and its pool bound, and the state is the authority on what
    // happened. Reports and timeouts are read back off it.
    const state = await orchestrator.runMarket(marketId);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    const reported = state.reports;
    const timedOut = state.timedOutAgents;
    step(
      reported.length > 0,
      `${reported.length} reports in ${elapsed}s`,
      `${timedOut.length} timed out`,
    );
    step(state.status === 'closed', `Market closed (${state.closedReason})`);
    step(state.referenceReport !== undefined, 'A terminal report exists to be the reference');

    for (const r of reported) {
      const clipped = r.belief[1] !== r.rawBelief[1] ? `  (clipped from ${r.rawBelief[1]})` : '';
      note(`  ${String(r.position).padStart(2)}. ${r.agentId}  P(yes)=${r.belief[1]}${clipped}`);
    }
    for (const agentId of timedOut) {
      note(`      ${agentId}  TIMED OUT — bond slashed, no stopping dice rolled`);
    }

    // Reports carry what they cost. This is the Graph story's only number.
    const costs = [...stored.annotations.values()]
      .map((a) => a.evidenceCostUsd ?? 0)
      .reduce((a, b) => a + b, 0);
    step(
      stored.annotations.size === reported.length,
      `${stored.annotations.size} reports carried slice + cost metadata`,
      `evidence spend $${costs.toFixed(4)}`,
    );

    // ---- 5. settle -----------------------------------------------------
    console.log('\n4. SETTLEMENT\n' + '-'.repeat(72));
    const settlement = await orchestrator.settle(marketId, '0.0.888');
    step(
      settlement.progress.complete,
      `Settled in ${settlement.progress.total} chunk(s)`,
      `${transfers.length} transfer(s) recorded, none sent`,
    );

    const inTinybar = settlement.plan.totalInTinybar;
    const outTinybar = settlement.plan.totalOutTinybar + settlement.plan.slashedTinybar;
    step(inTinybar === outTinybar, 'The books balance', `in ${inTinybar} = out ${outTinybar} tinybar`);

    // ---- 6. NOW the service sells an answer ----------------------------
    console.log('\n5. THE SAME QUESTION, NOW ANSWERABLE\n' + '-'.repeat(72));
    const sold = await post('/resolve', { question: QUESTION });
    step(sold.status === 200, `Answers 200 (HTTP ${sold.status})`);
    step(sold.body?.status === 'answered', 'Status is "answered"');

    const terminal = state.referenceReport?.belief[1];
    step(
      sold.body?.probability === terminal,
      'The price sold IS the terminal report',
      `sold ${sold.body?.probability}, terminal ${terminal}`,
    );
    step(
      sold.body?.agentBreakdown?.filter((a: { isReference: boolean }) => a.isReference).length === 1,
      'Exactly one report is marked as the reference',
    );
    step(
      typeof sold.body?.verify?.hcsTopicId === 'string' &&
        typeof sold.body?.verify?.mirrorUrl === 'string',
      'The answer carries the topic it can be checked against',
      sold.body?.verify?.mirrorUrl,
    );
    note(`evidence cost reported to the buyer: $${sold.body?.evidenceCostUsd}`);

    console.log('\n' + '='.repeat(72));
    console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
    console.log('');
  } finally {
    server.close();
  }

  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error(`\n  Check failed: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
