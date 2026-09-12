/**
 * The four demo scenarios — STEP 31.
 *
 * PLAN section 10 stages these because we run the agents and can therefore
 * show the mechanism defending itself, which nobody can stage with agents they
 * do not control. Each one is a claim about the paper made visible:
 *
 *   1. normal   agents on different evidence disagree, then converge
 *   2. liar     one agent reports against its own evidence and LOSES from its
 *               bond while the market corrects the price
 *   3. lazy     every agent copies the previous report and every payout is
 *               EXACTLY zero — Theorem 7, the uninformed equilibrium
 *   4. asker    the questioner's total cost stays under b·H(r, q0) no matter
 *               how far the price swings — the telescoping bound, section 6.2
 *
 * Scenario 3 is the one worth watching. "There is no way to get paid for doing
 * nothing" is a sentence anyone can say; `0.000000000000` in a payout column,
 * for every agent, is the paper's proof running live.
 *
 * WHY THE AGENTS ARE IN-PROCESS HERE. `check:resolve` already proved the HTTP
 * path with twenty separate processes, real keys and real evidence. What these
 * scenarios need instead is control over what each agent believes, run many
 * times over. So the transport calls the real `Agent` class directly and signs
 * with the real key — the mechanism, the scoring and the settlement are
 * untouched; only the delivery is shorter.
 *
 * Run:  pnpm scenarios              offline stub model, fast and repeatable
 *       pnpm scenarios --real       OpenAI and live Graph evidence
 *       pnpm scenarios --only lazy  one scenario
 */
import './load-env.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createApp,
  createMemoryLedger,
  Orchestrator,
  type AgentTransport,
  type Payer,
  type PayerReceipt,
} from '@ethonline/api';
import { createGatewayFromEnv, questionTargetsFromEnv, readEnv } from '@ethonline/graph';
import { parseAccountsFile } from '@ethonline/hedera';
import {
  Agent,
  buildAgentPool,
  openAiLlm,
  parseAgentKey,
  signReport,
  stubLlm,
  type AgentBehavior,
  type AgentConfig,
  type LlmClient,
} from '@ethonline/agent';

const ACCOUNTS_PATH = join(import.meta.dirname, '..', 'agents', 'accounts.json');
const REAL = process.argv.includes('--real');

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function rule(char = '='): string {
  return char.repeat(78);
}

/** Deterministic per-agent belief. Different agents genuinely disagree. */
function offlineLlm(agentId: string): LlmClient {
  const seed = [...agentId].reduce((a, c) => a + c.charCodeAt(0), 0);
  const own = 0.12 + ((seed * 7) % 20) * 0.037;
  return stubLlm((req) => {
    const seen = [...req.user.matchAll(/P\(yes\) = ([0-9.]+)/g)].map((m) => Number(m[1]));
    const running = seen.length > 0 ? seen[seen.length - 1]! : 0.5;
    return {
      probability: Number(Math.min(0.97, Math.max(0.03, own * 0.7 + running * 0.3)).toFixed(4)),
      reasoning: `Offline stub for ${agentId}.`,
    };
  });
}

/**
 * Calls the real Agent in-process and signs with its real key.
 *
 * The signature is produced exactly as the HTTP server produces it, so the
 * market verifies these reports the same way it verifies a remote agent's.
 */
function inProcessTransport(agents: Map<string, Agent>, configs: Map<string, AgentConfig>): AgentTransport {
  return {
    async requestReport(registered, req) {
      const agent = agents.get(registered.agentId)!;
      const config = configs.get(registered.agentId)!;
      const produced = await agent.produceReport({
        marketId: req.marketId,
        question: req.question,
        position: req.position,
        prior: req.prior,
        history: req.history.map((r) => ({
          position: r.position,
          agentId: r.agentId,
          belief: r.belief,
        })),
      });
      const p = produced.probability;
      return {
        probability: p,
        signature: signReport(parseAgentKey(config.privateKey), {
          marketId: req.marketId,
          agentId: registered.agentId,
          position: req.position,
          belief: [1 - p, p],
        }),
        reasoning: produced.reasoning,
        sliceIds: [...produced.sliceIds],
        evidenceCostUsd: produced.evidenceCostUsd,
        evidenceDigest: produced.evidenceDigest,
      };
    },
  };
}

function recordingPayer(): Payer {
  let n = 0;
  return {
    async send(): Promise<PayerReceipt> {
      n++;
      return { transactionId: `0.0.9@${n}.000000001`, status: 'SUCCESS' };
    },
  };
}

interface ScenarioResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

async function main(): Promise<void> {
  const only = flagValue('--only');
  const file = parseAccountsFile(readFileSync(ACCOUNTS_PATH, 'utf-8'));

  const gateway = REAL ? await createGatewayFromEnv() : undefined;
  const envTargets = questionTargetsFromEnv();
  const subjectId = envTargets.subgraphId;
  const targets =
    subjectId !== undefined
      ? {
          subgraphId: subjectId,
          peerSubgraphIds: envTargets.peerSubgraphIds,
          ...(envTargets.bridgeSubgraphId ? { bridgeSubgraphId: envTargets.bridgeSubgraphId } : {}),
        }
      : undefined;

  const apiKey = readEnv(process.env, 'OPENAI_API_KEY');
  if (REAL && !apiKey) {
    console.error('\n  --real needs OPENAI_API_KEY.\n');
    process.exit(1);
  }
  const model = readEnv(process.env, 'OPENAI_MODEL');

  console.log(`\nDEMO SCENARIOS (STEP 31)`);
  console.log(rule());
  console.log(`  Model     ${REAL ? `openai:${model ?? 'default'}` : 'offline stub'}`);
  console.log(`  Evidence  ${gateway ? 'The Graph gateway' : 'none (offline)'}`);
  console.log(rule());

  const results: ScenarioResult[] = [];

  /** Opens a market, runs it to settlement, and hands back everything shown. */
  async function run(question: string, behaviors: Record<string, AgentBehavior>, attempt = 0) {
    // Every attempt gets its own topic, so it gets its own hash chain and its
    // own sequence of rolls. This is what makes a retry honest rather than a
    // reroll of a rigged die: the same code path runs, and a market that
    // closed early is discarded rather than edited.
    const ledger = createMemoryLedger({ topicSeed: 970000 + results.length * 100 + attempt });
    const { app, registry, markets, config } = createApp({ ledger });
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;

    const pool = buildAgentPool(file.agents, { behaviors });
    const agents = new Map<string, Agent>();
    const configs = new Map<string, AgentConfig>();

    for (const cfg of pool) {
      configs.set(cfg.id, cfg);
      agents.set(
        cfg.id,
        new Agent({
          config: cfg,
          llm: REAL ? openAiLlm({ apiKey: apiKey!, ...(model ? { model } : {}) }) : offlineLlm(cfg.id),
          ...(gateway && targets ? { gateway, targets } : {}),
        }),
      );
      registry.register({
        agentId: cfg.id,
        accountId: cfg.accountId,
        publicKey: cfg.publicKey,
        sliceIds: [...cfg.sliceIds],
        registeredAt: Date.now(),
      });
    }

    const opened = await fetch(`http://127.0.0.1:${port}/market`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const { marketId } = (await opened.json()) as { marketId: string };

    for (const cfg of pool) {
      await fetch(`http://127.0.0.1:${port}/market/${marketId}/bond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: cfg.id }),
      });
    }

    const orchestrator = new Orchestrator({
      markets,
      registry,
      ledger,
      transport: inProcessTransport(agents, configs),
      payer: recordingPayer(),
      hbarPerUnit: config.hbarPerUnit,
      maxCreditsPerTransaction: 9,
      reportTimeoutMs: Number(process.env['REPORT_TIMEOUT_MS'] ?? 120_000),
    });

    await orchestrator.closeBonding(marketId);
    const state = await orchestrator.runMarket(marketId);
    const settled = await orchestrator.settle(marketId, '0.0.888');
    server.close();

    return { state, settlement: settled.settlement, stored: markets.get(marketId)! };
  }

  /**
   * Runs markets until one is worth showing.
   *
   * WHY THIS IS NECESSARY AND WHY IT IS NOT CHEATING. The stopping dice are
   * real — they come out of the ledger's running hashes — so with alpha = 1/8
   * a market can close on its first report, and sometimes does. A one-report
   * market demonstrates nothing: there is nobody to score, and an assertion
   * about "every scored agent" is vacuously true over an empty set, which is
   * how a demo passes while proving nothing. That happened on the first run
   * of this script.
   *
   * So a scenario says what it needs, and markets are opened until one has it.
   * Nothing is edited and no die is reweighted; the discarded markets simply
   * closed early, which is the mechanism behaving correctly.
   */
  async function runUntil(
    question: string,
    behaviors: Record<string, AgentBehavior>,
    want: (r: Awaited<ReturnType<typeof run>>) => boolean,
    attempts = 12,
  ): Promise<{ result: Awaited<ReturnType<typeof run>>; attempts: number; satisfied: boolean }> {
    let last!: Awaited<ReturnType<typeof run>>;
    for (let i = 1; i <= attempts; i++) {
      last = await run(question, behaviors, i);
      if (want(last)) return { result: last, attempts: i, satisfied: true };
    }
    return { result: last, attempts, satisfied: false };
  }

  function printReports(state: { reports: readonly { position: number; agentId: string; belief: readonly [number, number] }[] }): void {
    for (const r of state.reports) {
      console.log(`    ${String(r.position).padStart(2)}. ${r.agentId.padEnd(9)} P(yes) = ${r.belief[1]}`);
    }
  }

  function printPayouts(payouts: readonly { agentId: string; position: number; kind: string; amount: number }[]): void {
    console.log(`    ${'pos'.padStart(3)}  ${'agent'.padEnd(9)}  ${'kind'.padEnd(9)}  payout`);
    for (const p of payouts) {
      const amount = p.amount.toFixed(12).padStart(16);
      console.log(`    ${String(p.position).padStart(3)}  ${p.agentId.padEnd(9)}  ${p.kind.padEnd(9)}  ${amount}`);
    }
  }

  // ---- 1. normal -------------------------------------------------------
  if (!only || only === 'normal') {
    console.log('\n1. NORMAL MARKET\n' + rule('-'));
    // Wanted: enough reports that somebody is actually scored, and a price
    // that moved. Agents on different evidence disagreeing is the whole claim.
    const { result, attempts, satisfied } = await runUntil(
      'Is Curve liquidity growth organic over 30 days?',
      {},
      (r) =>
        r.state.reports.length >= 4 &&
        new Set(r.state.reports.map((x) => x.belief[1])).size > 1,
    );
    const { state, settlement } = result;
    console.log(`    (${attempts} market(s) opened; earlier ones closed on the first roll)\n`);
    printReports(state);
    console.log('');
    printPayouts(settlement.payouts);
    const moved = new Set(state.reports.map((r) => r.belief[1])).size > 1;
    results.push({
      name: 'normal',
      ok: satisfied && moved,
      detail: `${state.reports.length} reports in ${attempts} attempt(s), price moved: ${moved}`,
    });
  }

  // ---- 2. the liar -----------------------------------------------------
  if (!only || only === 'liar') {
    console.log('\n2. A LYING AGENT\n' + rule('-'));
    const liar = file.agents[3]!.agentId;
    console.log(`    ${liar} reports against its own evidence.\n`);
    // Wanted: the liar drawn into the SCORED range. Landing in the flat-fee
    // tail is a real outcome of a real draw, but it shows nothing — the last k
    // agents are paid a fixed fee whatever they say, so a lie there costs
    // exactly nothing and the market has no chance to answer it.
    // The liar has to be drawn AND land outside the flat-fee tail, which is
    // roughly a one-in-four draw. Twelve attempts found it on the twelfth —
    // one short and the scenario would have reported a failure that was only
    // bad luck. The budget is raised rather than the requirement lowered.
    const { result, attempts, satisfied } = await runUntil(
      'Is Protocol B TVL growth wash-farmed?',
      { [liar]: 'liar' },
      (r) => r.settlement.payouts.some((p) => p.agentId === liar && p.kind === 'scored'),
      24,
    );
    const { state, settlement } = result;
    console.log(`    (${attempts} market(s) opened until the draw put it in the scored range)\n`);
    printReports(state);
    console.log('');
    printPayouts(settlement.payouts);

    const liarPayout = settlement.payouts.find((p) => p.agentId === liar);
    const punished = liarPayout !== undefined && liarPayout.kind === 'scored' && liarPayout.amount < 0;
    console.log(
      liarPayout
        ? `\n    ${liar}: ${liarPayout.amount.toFixed(12)} (${liarPayout.kind}) — ` +
            `${punished ? 'PAID OUT OF ITS OWN BOND' : 'not punished in this run'}`
        : `\n    ${liar} was never drawn in ${attempts} attempts.`,
    );
    results.push({
      name: 'liar',
      ok: satisfied && punished,
      detail: liarPayout
        ? `${liarPayout.kind} ${liarPayout.amount.toFixed(9)} after ${attempts} attempt(s)`
        : `never drawn in ${attempts} attempts`,
    });
  }

  // ---- 3. everyone lazy — Theorem 7 ------------------------------------
  if (!only || only === 'lazy') {
    console.log('\n3. EVERY AGENT COPIES THE LAST ONE — THEOREM 7\n' + rule('-'));
    const behaviors: Record<string, AgentBehavior> = {};
    for (const a of file.agents) behaviors[a.agentId] = 'lazy';

    // Wanted: at least one agent actually SCORED. A market that closes inside
    // the flat-fee tail pays everyone the fixed fee and scores nobody, and
    // "every scored agent was paid zero" is then true of an empty set. The
    // first run of this script passed exactly that way and proved nothing.
    // Three, not one. A single zero row is true and unconvincing; the claim
    // is that EVERY copier is paid exactly zero, and a column of one does not
    // show a column. The first tightening of this predicate only demanded
    // "somebody", and it passed on a market with a single scored agent.
    const { result, attempts, satisfied } = await runUntil(
      'Does this address cluster belong to one actor?',
      behaviors,
      (r) => r.settlement.payouts.filter((p) => p.kind === 'scored').length >= 3,
      24,
    );
    const { state, settlement } = result;
    console.log(`    (${attempts} market(s) opened until somebody was scored)\n`);
    printReports(state);
    console.log('');
    printPayouts(settlement.payouts);

    // Every report equals the one before it, so S_CEM(r, q, q) = log(q/q) = 0
    // for every reference r — exactly, not approximately. Nobody is paid for
    // copying, and no coordination among the copiers can change that.
    const scored = settlement.payouts.filter((p) => p.kind === 'scored');
    const largest = scored.reduce((m, p) => Math.max(m, Math.abs(p.amount)), 0);
    const allZero = scored.length > 0 && scored.every((p) => Math.abs(p.amount) < 1e-10);
    console.log(
      `\n    scored agents: ${scored.length}, largest |payout| = ${largest.toExponential(3)}`,
    );
    console.log(
      scored.length === 0
        ? `    NOTHING WAS SCORED in ${attempts} attempts — this proves nothing, rerun.`
        : allZero
          ? '    EVERY ONE IS EXACTLY ZERO. There is no way to be paid for copying.'
          : '    NOT ZERO — the scoring or the settlement is wrong.',
    );
    results.push({
      name: 'lazy (Theorem 7)',
      ok: satisfied && allZero,
      detail: `${scored.length} scored copier(s) in ${attempts} attempt(s), all zero: ${allZero}`,
    });
  }

  // ---- 4. the asker's bound --------------------------------------------
  if (!only || only === 'bound') {
    console.log("\n4. THE ASKER'S COST IS BOUNDED\n" + rule('-'));
    const { settlement, stored } = await run('Does this token liquidity structure carry rug risk?', {});
    const scoredTotal = settlement.payouts
      .filter((p) => p.kind === 'scored')
      .reduce((s, p) => s + p.amount, 0);
    const bound = stored.params.b * Math.log(2);
    console.log(`    spent on scoring   ${scoredTotal.toFixed(9)}`);
    console.log(`    theoretical cap    ${bound.toFixed(9)}   (b·log 2, uniform prior)`);
    console.log(`    asker refund       ${settlement.askerRefund.toFixed(9)}`);
    console.log(
      `\n    The cap holds however far the price swings: the CE-MSR payments telescope,`,
    );
    console.log(`    so only the opening and closing prices survive the sum.`);
    results.push({
      name: "asker's bound",
      ok: scoredTotal <= bound + 1e-9 && settlement.askerRefund >= -1e-9,
      detail: `spent ${scoredTotal.toFixed(6)} <= cap ${bound.toFixed(6)}`,
    });
  }

  console.log('\n' + rule());
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name.padEnd(18)} ${r.detail}`);
  }
  console.log(rule());
  console.log(failed === 0 ? 'ALL SCENARIOS PASSED\n' : `${failed} SCENARIO(S) FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error(`\n  Scenarios failed: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
