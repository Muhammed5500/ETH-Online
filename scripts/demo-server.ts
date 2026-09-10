/**
 * A demo server: the whole API, no chain, no facilitator, no money.
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
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivateKey } from '@hashgraph/sdk';
import { DEFAULT_PARAMS, type MarketParams } from '@ethonline/core';
import {
  canonicalReportMessage,
  createApp,
  createMemoryLedger,
  Orchestrator,
  type AgentTransport,
  type Payer,
  type PayerReceipt,
  type ReportClaim,
} from '@ethonline/api';

const PORT = Number(process.env['DEMO_PORT'] ?? 4021);
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
      };
    },
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
  const { app, registry, markets, config } = createApp({ ledger });
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
      headers: { 'content-type': 'application/json' },
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
    console.log('\nethonline DEMO server (no chain, no money)');
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
