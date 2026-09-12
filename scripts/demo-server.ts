/**
 * A demo server: the whole API over an in-memory ledger.
 *
 * TWO MODES, AND THE DEFAULT IS THE PAID ONE.
 *
 *   paid   HEDERA_TREASURY_ID and HEDERA_TREASURY_KEY are set. `POST /market`
 *          goes through the SAME x402 gate the real server uses, quoting the
 *          same computed deposit, settled by the same facilitator against
 *          Hedera testnet. A browser with no wallet gets 402 and no market.
 *   free   no treasury configured, or `--free`. Anyone can open a market for
 *          nothing. Fine for building pages, wrong for showing the product,
 *          so the banner says which mode is running in both cases.
 *
 * WHAT IS GATED HERE AND WHAT IS NOT. Only `POST /market`, the one action a
 * visitor performs. Bonds stay free because this demo's twenty agents are
 * fabricated accounts with no balance; on the real server they pay like
 * everybody else. That difference is a property of the fake pool, not of the
 * gate.
 *
 * WHAT THE ASKER'S HBAR ACTUALLY BUYS IN PAID MODE. The deposit really leaves
 * the wallet and really lands in the treasury. The refund does NOT come back:
 * settlement here runs through a payer that records transfers instead of
 * sending them, because the agents being paid do not exist. So paid mode
 * proves the price and the payment rail, not the round trip. `pnpm api` with
 * `pnpm agents` is the run where the money comes back.
 *
 * WHY THIS EXISTS. The real server needs Hedera credentials, a reachable
 * facilitator and about a hundred seconds to run one market. Building four
 * frontend pages against that means every reload costs testnet time, and a
 * facilitator hiccup looks like a frontend bug. This runs the SAME app object
 * over the same in-memory ledger the unit tests use, with markets already
 * seeded in every state a page has to render.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT. The mechanism is real: `core` runs
 * unmodified, agents are drawn from running hashes, the stopping dice come out
 * of those hashes, and settlement goes through the same arithmetic and the
 * same invariant checks. What is fake is the ledger (a Map, not HCS), the
 * payer (records transfers instead of sending them) and the agents' beliefs
 * (a scripted persona instead of a model reading Graph data).
 *
 * So a page that looks right here will look right against testnet, and a
 * market that settles here would settle there. It is not evidence that Hedera
 * works — STEP 17 is that — it is evidence that the screens are wired to the
 * mechanism rather than to a fixture.
 *
 * Run:  pnpm demo
 */
import './load-env.js';
import express, { type RequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivateKey } from '@hashgraph/sdk';
import { DEFAULT_PARAMS, type MarketParams } from '@ethonline/core';
import { readEnv, treasuryFromEnv } from '@ethonline/hedera';
import {
  canonicalReportMessage,
  createApp,
  createMemoryLedger,
  createPaymentGate,
  DEFAULT_API_CONFIG,
  DEFAULT_FACILITATOR_TIMEOUT_MS,
  depositTinybar,
  formatTinybar,
  MarketStore,
  Orchestrator,
  warmUpFacilitator,
  type AgentTransport,
  type Payer,
  type PayerReceipt,
  type ReportClaim,
} from '@ethonline/api';

const PORT = Number(process.env['DEMO_PORT'] ?? 4021);

/** `pnpm demo --free` opens markets for nothing, the way this server used to. */
const FREE_MODE = process.argv.includes('--free');

/**
 * Lets the seeder open its fixture markets without paying.
 *
 * The fixtures exist so the pages have something to render, and making them
 * pay would mean the demo could not start without a funded wallet and a
 * healthy facilitator. So they carry a header the gate skips.
 *
 * It is a per-process random value that is never printed, never written down
 * and gone when the process exits, so nothing arriving over the network can
 * present it. The one caller that knows it is `open()` below.
 */
const FIXTURE_HEADER = 'x-demo-fixture';
const FIXTURE_TOKEN = randomUUID();
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = resolve(HERE, '..', 'apps', 'web', 'dist');

/**
 * The paths the API owns.
 *
 * Anything else that arrives as a GET is a page and gets the SPA shell. The
 * frontend deliberately does not use these names for its own routes — see the
 * note in `apps/web/src/lib/api.ts` for why the API kept them.
 */
const API_PREFIXES = ['/market', '/markets', '/agents', '/health', '/resolve'];

/**
 * An agent with a key, a persona and a data slice.
 *
 * The persona is what keeps the demo honest-looking. PLAN section 7.1: if
 * twenty agents all say 0.72 the market looks dead and staged. Each of these
 * starts somewhere different because it is looking at different evidence, and
 * they converge as reports accumulate — which is the behaviour the mechanism
 * is supposed to produce, not a scripted animation of it.
 */
interface DemoAgent {
  readonly agentId: string;
  readonly accountId: string;
  readonly key: PrivateKey;
  readonly publicKey: string;
  readonly sliceIds: readonly string[];
  /** Where this agent starts before it has seen anyone else. */
  readonly prior: number;
  /** How much it moves toward the running consensus. 0 is stubborn, 1 is a copycat. */
  readonly herding: number;
}

const SLICES = ['liquidity', 'holders', 'activity', 'bridge', 'comparative'] as const;

function makeAgents(count: number): DemoAgent[] {
  return Array.from({ length: count }, (_, i) => {
    const key = PrivateKey.generateECDSA();
    // Spread the starting beliefs across the range rather than clustering
    // them, so the first few reports actually disagree.
    const prior = 0.12 + ((i * 7) % 20) * 0.037;
    return {
      agentId: `agent-${String(i + 1).padStart(2, '0')}`,
      accountId: `0.0.${1000 + i}`,
      key,
      publicKey: key.publicKey.toStringDer(),
      sliceIds: [SLICES[i % SLICES.length]!],
      prior: Math.min(0.9, Math.max(0.1, prior)),
      herding: 0.25 + ((i * 3) % 5) * 0.1,
    };
  });
}

function signFor(agent: DemoAgent, claim: ReportClaim): string {
  const bytes = new Uint8Array(Buffer.from(canonicalReportMessage(claim), 'utf-8'));
  return Buffer.from(agent.key.sign(bytes)).toString('hex');
}

/**
 * The scripted transport.
 *
 * An agent blends its own prior with the running price. That is roughly what a
 * real agent does — the paper's whole setup has each one seeing every earlier
 * report — and it produces a price that moves early and settles later, which
 * is what the chart needs to show.
 */
function demoTransport(agents: readonly DemoAgent[], liar?: string): AgentTransport {
  return {
    async requestReport(agent, req) {
      const demo = agents.find((a) => a.agentId === agent.agentId)!;
      const last = req.history[req.history.length - 1];
      const running = last ? last.belief[1] : req.prior[1];
      let p = demo.prior * (1 - demo.herding) + running * demo.herding;
      // The liar deliberately drags the price the wrong way. Scenario 2.
      if (liar && agent.agentId === liar) p = 1 - p;
      p = Math.min(0.97, Math.max(0.03, Number(p.toFixed(4))));

      return {
        probability: p,
        signature: signFor(demo, {
          marketId: req.marketId,
          agentId: agent.agentId,
          position: req.position,
          belief: [1 - p, p],
        }),
        // Display-only, but not filler: STEP 20's real agent reports the same
        // three things, so the page is built against the shape it will get.
        reasoning: reasonFor(demo, running, p, liar === agent.agentId),
        sliceIds: [...demo.sliceIds],
        evidenceCostUsd: demo.sliceIds.length * 0.01,
      };
    },
  };
}

/**
 * A sentence in the voice of whichever slice the agent looked at.
 *
 * Not a decoration. The report feed's job is to show that agents disagree
 * because they are looking at DIFFERENT evidence — that is Assumption 4 made
 * visible — so the text has to name the slice and say something a reader can
 * connect to the number beside it.
 */
function reasonFor(agent: DemoAgent, before: number, after: number, lying: boolean): string {
  const slice = agent.sliceIds[0] ?? 'liquidity';
  const findings: Record<string, string> = {
    liquidity:
      'the top pool holds most of the TVL and turns over several times its own depth each day',
    holders:
      'deposits cluster into a handful of addresses, and most depositors appear exactly once',
    activity:
      'swap inter-arrival times are unusually regular and a large share have the same address on both sides',
    bridge:
      'inflow and outflow are close to balanced, so capital arrives, is counted, and leaves',
    comparative:
      'turnover ranks above every peer while revenue yield ranks below all of them',
  };
  const direction =
    after > before ? 'pushing the price up' : after < before ? 'pulling it down' : 'holding steady';
  return lying
    ? `Reading the ${slice} slice, ${findings[slice]}. Reporting against it anyway.`
    : `On the ${slice} slice, ${findings[slice]}. ${direction[0]!.toUpperCase()}${direction.slice(1)} from ${(before * 100).toFixed(1)}%.`;
}

/**
 * Runs the x402 gate for `POST /market` and nothing else.
 *
 * `createPaymentGate` already narrows itself to the three paid routes, so this
 * narrows it further rather than widening it: bonds and `POST /resolve` stay
 * free here because the pool they would be paid by is fabricated. Wrapping is
 * the whole change — the gate itself, the price function and the facilitator
 * are the production ones, so a 402 seen here is the 402 the real server
 * sends.
 */
function gateMarketOpen(gate: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const path = req.path.split('?')[0] ?? req.path;
    if (req.method !== 'POST' || !/^\/market\/?$/.test(path)) return next();
    if (req.get(FIXTURE_HEADER) === FIXTURE_TOKEN) return next();
    return gate(req, res, next);
  };
}

/** Records transfers instead of sending them. */
function demoPayer(log: Array<{ memo: string; total: bigint }>): Payer {
  return {
    async send(lines, memo): Promise<PayerReceipt> {
      const total = lines.reduce((s, l) => s + l.amountTinybar, 0n);
      log.push({ memo, total });
      return { transactionId: `0.0.9@${log.length}.000000001`, status: 'SUCCESS' };
    },
  };
}

async function main(): Promise<void> {
  const ledger = createMemoryLedger({ topicSeed: 990000 });

  // The store is built here rather than inside `createApp` because the gate
  // needs it too: a bond's price is whatever that market set, so the price
  // function looks the market up. Both sides must see the same store.
  const markets = new MarketStore();

  const treasury = FREE_MODE ? undefined : treasuryFromEnv();
  const facilitatorUrl =
    readEnv(process.env, 'BLOCKY402_FACILITATOR_URL') ?? 'https://api.testnet.blocky402.com';
  // Scales what one mechanism unit costs. A default market is a shade under
  // one unit, so 1 makes the deposit about 1 HBAR; drop it to 0.1 if the
  // wallet you are demoing with is thin.
  const hbarPerUnit = Number(
    readEnv(process.env, 'DEMO_HBAR_PER_UNIT') ?? DEFAULT_API_CONFIG.hbarPerUnit,
  );

  // Cold-start the facilitator connection before anyone is waiting on it, for
  // the same reason the real server does (STEP 17).
  const warm = treasury ? await warmUpFacilitator(facilitatorUrl) : undefined;

  const paymentGate = treasury
    ? gateMarketOpen(
        createPaymentGate({
          treasuryAccountId: treasury.accountId,
          facilitatorUrl,
          facilitatorTimeoutMs: Number(
            readEnv(process.env, 'FACILITATOR_TIMEOUT_MS') ?? DEFAULT_FACILITATOR_TIMEOUT_MS,
          ),
          markets,
          defaultParams: DEFAULT_PARAMS,
          hbarPerUnit,
        }),
      )
    : undefined;

  const { app, registry, config } = createApp({
    ledger,
    markets,
    config: { hbarPerUnit },
    ...(paymentGate ? { paymentGate } : {}),
  });
  const agents = makeAgents(DEFAULT_PARAMS.minPoolSize);
  const transfers: Array<{ memo: string; total: bigint }> = [];

  for (const a of agents) {
    registry.register({
      agentId: a.agentId,
      accountId: a.accountId,
      publicKey: a.publicKey,
      endpoint: `demo://${a.agentId}`,
      sliceIds: [...a.sliceIds],
      registeredAt: Date.now(),
    });
  }

  const orchestrator = (liar?: string): Orchestrator =>
    new Orchestrator({
      markets,
      registry,
      ledger,
      transport: demoTransport(agents, liar),
      payer: demoPayer(transfers),
      hbarPerUnit: config.hbarPerUnit,
      maxCreditsPerTransaction: 9,
    });

  /** Opens a market through the real route, then bonds the pool. */
  const open = async (question: string, params?: Partial<MarketParams>): Promise<string> => {
    const res = await fetch(`http://127.0.0.1:${PORT}/market`, {
      method: 'POST',
      // The one caller allowed past the gate. See FIXTURE_TOKEN.
      headers: { 'content-type': 'application/json', [FIXTURE_HEADER]: FIXTURE_TOKEN },
      body: JSON.stringify({ question, params }),
    });
    if (!res.ok) throw new Error(`open failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { marketId: string };
    for (const a of agents) {
      await fetch(`http://127.0.0.1:${PORT}/market/${body.marketId}/bond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: a.agentId }),
      });
    }
    return body.marketId;
  };

  // ---- static frontend, when it has been built --------------------------
  //
  // The fallback is a plain middleware and not a route pattern. Express 5
  // routes go through path-to-regexp, and handing it a catch-all for a SPA is
  // a fight over syntax that gets rewritten every major version. Deciding in
  // JavaScript what an API path is costs three lines and cannot be broken by
  // an upgrade.
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      if (API_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
      return res.sendFile(join(WEB_DIST, 'index.html'));
    });
  }

  /**
   * Opens markets until one survives a few rounds.
   *
   * Each market gets its own topic, so each gets a different hash chain and a
   * different sequence of rolls. Nothing is rigged: the same code path runs,
   * and a market that closes early is simply discarded and left in the list as
   * the closed market it honestly is.
   */
  const seedRunningMarket = async (
    attempts = 6,
    wantReports = 4,
  ): Promise<{ id: string; reports: number; attempts: number } | undefined> => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const id = await open('Does this address cluster belong to a single actor?');
      const orch = orchestrator();
      await orch.closeBonding(id);
      for (let i = 0; i < wantReports; i++) {
        const stored = markets.get(id)!;
        if (stored.market.status !== 'running') break;
        await orch.runRound(id);
      }
      const stored = markets.get(id)!;
      if (stored.market.status === 'running') {
        return { id, reports: stored.market.reportCount, attempts: attempt };
      }
    }
    return undefined;
  };

  // A port already in use means an older demo is still running, and the
  // symptom is baffling: this process seeds markets into THAT server's store
  // over HTTP, then cannot find them in its own. Fail loudly instead.
  const server = app.listen(PORT, async () => {
    console.log('');
    console.log(
      `ethonline DEMO server — ledger in memory, ${treasury ? 'DEPOSITS ARE PAID FOR REAL' : 'NO PAYMENT REQUIRED'}`,
    );
    console.log('='.repeat(64));
    if (treasury) {
      console.log('  Payment     POST /market is gated by x402, the same gate the real server uses');
      console.log(`  Treasury    ${treasury.accountId} — receives the deposit, in testnet HBAR`);
      console.log(
        `  Facilitator ${facilitatorUrl}  ` +
          (warm?.ok ? `(reachable, ${warm.ms}ms)` : `(UNREACHABLE: ${warm?.error ?? 'unknown'})`),
      );
      console.log(
        `  Deposit     ${formatTinybar(depositTinybar(DEFAULT_PARAMS, [0.5, 0.5], hbarPerUnit))} at the default parameters`,
      );
      console.log('  NOTE        the deposit is really taken and is NOT refunded here: settlement');
      console.log('              records transfers instead of sending them, because this pool is fake.');
      if (!warm?.ok) {
        console.log('  WARNING     the facilitator is unreachable, so opening a market answers 503.');
      }
    } else {
      console.log(
        `  Payment     NONE — anyone can open a market for nothing${FREE_MODE ? ' (--free)' : ''}.`,
      );
      if (!FREE_MODE) {
        console.log('              Set HEDERA_TREASURY_ID and HEDERA_TREASURY_KEY to charge the deposit.');
      }
    }
    console.log('='.repeat(64));

    try {
      // One market per state a page has to render.
      const bonding = await open('Is Protocol A liquidity growth organic over 30 days?');
      console.log(`  bonding    ${bonding}`);

      // A market that is still open mid-flight, for the live page.
      //
      // This takes more than one attempt on purpose. The stopping dice are
      // real — they come out of the ledger's running hashes — so a market can
      // close on its first report and sometimes does. Forcing one to stay open
      // would mean faking the one thing the live page exists to show, so
      // instead we open markets until the dice leave one running.
      const running = await seedRunningMarket();
      console.log(
        running
          ? `  running    ${running.id}  (${running.reports} reports, ${running.attempts} attempt(s))`
          : '  running    none — the dice closed every attempt, rerun to get one',
      );

      const settled = await open('Is Protocol B TVL growth wash-farmed?');
      const orchSettled = orchestrator();
      await orchSettled.runMarket(settled);
      await orchSettled.settle(settled, '0.0.888');
      console.log(`  settled    ${settled}`);

      const withLiar = await open('Does this token liquidity structure carry rug risk?');
      const orchLiar = orchestrator(agents[3]!.agentId);
      await orchLiar.runMarket(withLiar);
      await orchLiar.settle(withLiar, '0.0.888');
      console.log(`  settled    ${withLiar}  (one agent reports the opposite on purpose)`);

      console.log('='.repeat(64));
      console.log(`  API        http://127.0.0.1:${PORT}`);
      console.log(
        `  Web        ${existsSync(WEB_DIST) ? `http://127.0.0.1:${PORT}` : 'not built — run `pnpm --filter @ethonline/web build`'}`,
      );
      console.log(`  Transfers  ${transfers.length} recorded, none sent\n`);
    } catch (e) {
      console.error(`\n  Seeding failed: ${(e as Error).message}\n`);
    }

    /**
     * Picks up markets somebody else opened, and runs them.
     *
     * WHY THIS EXISTS. The seeding above bonds this server's pool to the
     * markets IT creates. Nothing was watching for anyone else's, so a market
     * opened through the Ask page sat at `bonding` with zero agents forever.
     * That is scenario 4 in PLAN section 10, the one where a juror asks their
     * own question and watches it run, and it was the one path through the UI
     * that went nowhere.
     *
     * In paid mode a market only reaches this loop because its deposit was
     * paid, so what gets picked up is a market somebody actually bought.
     *
     * Nothing about the mechanism changes. The pool bonds through the same
     * open route any agent would use, and the market runs through the same
     * orchestrator, dice and settlement as the seeded ones.
     */
    const handled = new Set(markets.list().map((m) => m.id));
    let busy = false;

    setInterval(() => {
      if (busy) return;
      const fresh = markets.list().filter((m) => !handled.has(m.id));
      if (fresh.length === 0) return;

      busy = true;
      void (async () => {
        try {
          for (const stored of fresh) {
            handled.add(stored.id);
            console.log(`  picked up ${stored.id} — ${stored.question}`);
            try {
              for (const a of agents) {
                await fetch(`http://127.0.0.1:${PORT}/market/${stored.id}/bond`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ agentId: a.agentId }),
                });
              }
              const orch = orchestrator();
              await orch.closeBonding(stored.id);
              await orch.runMarket(stored.id);
              await orch.settle(stored.id, '0.0.888');
              const done = markets.get(stored.id)!;
              console.log(
                `  ${stored.id} settled — ${done.market.reportCount} reports, ` +
                  `closing price ${done.market.currentPrice()[1]}\n`,
              );
            } catch (e) {
              // A market that fails here stays in the list as whatever state
              // it reached. Marking it handled is deliberate: retrying a
              // half-run market would bond twice and is worse than leaving it.
              console.error(`  ${stored.id} could not be run: ${(e as Error).message}\n`);
            }
          }
        } finally {
          busy = false;
        }
      })();
    }, 2000);
  });

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(
        `
  Port ${PORT} is already in use — an older demo server is still running.
` +
          `  Stop it first, or set DEMO_PORT to something else.
`,
      );
    } else {
      console.error(`
  Demo server failed: ${e.message}
`);
    }
    process.exit(1);
  });

  const shutdown = (): void => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
