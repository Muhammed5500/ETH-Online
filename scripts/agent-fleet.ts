/**
 * Boots the twenty agents and registers them with a running API — STEP 21.
 *
 * WHAT THIS PROVES THAT A UNIT TEST CANNOT. The pool tests show that no two
 * agents share a slice set. This shows that twenty processes, each holding its
 * own Hedera key, each buying its own evidence from The Graph, will answer the
 * orchestrator over HTTP and produce signatures the market accepts. Those are
 * different claims and only the second one can fail on demo day.
 *
 * EACH AGENT IS ITS OWN SERVER, ON ITS OWN PORT. Not a loop inside the
 * orchestrator. The orchestrator reaches agents over HTTP and enforces a
 * deadline with an AbortSignal, and an agent that shares a process with it
 * cannot time out the way a real one does — so the timeout path, which is the
 * one that slashes bonds, would never be exercised by the thing we ship.
 *
 * EACH AGENT PAYS ITS OWN BOND. The fleet watches the API for markets in
 * `bonding`, asks each agent whether it wants in, and pays with that agent's
 * own Hedera key over x402. Every earlier run had a gate script holding all
 * twenty keys and bonding on everyone's behalf, which proves the route works
 * and is not the product: a third party's agent has to be able to do this with
 * a key nobody here has. `--no-bond` turns it off for a run that only wants
 * the report side.
 *
 * Run:  pnpm agents                    twenty agents, real model, real Graph
 *       pnpm agents --offline          a stub model, no OpenAI key needed
 *       pnpm agents --no-bond          listen and report, never join a market
 *       pnpm agents --count 5          a smaller pool
 *       pnpm agents --liar agent-04    stage scenario 2
 *       pnpm agents --lazy all         stage scenario 3 (Theorem 7)
 */
import './load-env.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import {
  createClientHederaSigner,
  ExactHederaScheme,
  HBAR_ASSET_ID,
  HEDERA_TESTNET_CAIP2,
  PrivateKey,
} from '@x402/hedera';
import { createGatewayFromEnv, questionTargetsFromEnv, readEnv } from '@ethonline/graph';
import { parseAccountsFile } from '@ethonline/hedera';
import {
  Agent,
  BondingWatcher,
  buildAgentPool,
  createAgentServer,
  openAiLlm,
  signRegistration,
  stubLlm,
  type AgentBehavior,
  type LlmClient,
} from '@ethonline/agent';

const ACCOUNTS_PATH = join(import.meta.dirname, '..', 'agents', 'accounts.json');
const BASE_PORT = Number(process.env['AGENT_BASE_PORT'] ?? 4100);
const API_URL = process.env['API_URL'] ?? 'http://127.0.0.1:4021';

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * The most one agent will ever pay for a single bond, in tinybar.
 *
 * A wrapped fetch pays whatever the 402 asks for, and the bond price is set by
 * whoever opened the market. A default market's bond is 1 HBAR; five leaves
 * room for unusual parameters and refuses anything that looks like a drain.
 */
const MAX_BOND_TINYBAR = BigInt(readEnv(process.env, 'AGENT_MAX_BOND_TINYBAR') ?? '500000000');

/** A fetch that answers a 402 by paying it, with this agent's own key. */
function payingFetch(accountId: string, privateKey: string) {
  const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), {
    network: HEDERA_TESTNET_CAIP2,
  });
  const client = x402Client.fromConfig({
    schemes: [{ network: HEDERA_TESTNET_CAIP2, client: new ExactHederaScheme(signer) }],
    // SPIKE A trap: HBAR is not a "default asset", so without this every
    // payment is refused client-side before it is ever attempted.
    spendControls: {
      allowedAssets: [
        {
          network: HEDERA_TESTNET_CAIP2,
          asset: HBAR_ASSET_ID,
          maxAmountPerPayment: MAX_BOND_TINYBAR.toString(),
        },
      ],
    },
  });
  return wrapFetchWithPayment(fetch, client);
}

/**
 * A stub that still disagrees with itself across agents.
 *
 * Used by `--offline`. A stub that answered 0.5 every time would make the
 * fleet look like it works while hiding the one thing worth looking at: that
 * agents on different slices start in different places. This derives a
 * starting belief from the agent id and pulls it toward the running price, the
 * same shape the demo server uses.
 */
function offlineLlm(agentId: string): LlmClient {
  const seed = [...agentId].reduce((a, c) => a + c.charCodeAt(0), 0);
  const own = 0.12 + ((seed * 7) % 20) * 0.037;
  return stubLlm((req) => {
    const seen = [...req.user.matchAll(/P\(yes\) = ([0-9.]+)/g)].map((m) => Number(m[1]));
    const running = seen.length > 0 ? seen[seen.length - 1]! : 0.5;
    const p = Math.min(0.97, Math.max(0.03, own * 0.7 + running * 0.3));
    return {
      probability: Number(p.toFixed(4)),
      reasoning: `Offline stub for ${agentId}; no model was called.`,
    };
  });
}

async function main(): Promise<void> {
  const offline = process.argv.includes('--offline');
  const bonding = !process.argv.includes('--no-bond');
  const count = Number(flagValue('--count') ?? 20);
  const liar = flagValue('--liar');
  const lazy = flagValue('--lazy');

  const file = parseAccountsFile(readFileSync(ACCOUNTS_PATH, 'utf-8'));

  const behaviors: Record<string, AgentBehavior> = {};
  if (liar) behaviors[liar] = 'liar';
  if (lazy === 'all') {
    for (const a of file.agents) behaviors[a.agentId] = 'lazy';
  } else if (lazy) {
    behaviors[lazy] = 'lazy';
  }

  const pool = buildAgentPool(file.agents, { behaviors, limit: count });

  // One gateway for the fleet. Every agent pays for its own queries through
  // it; the spend log is shared so the total cost of a market is one number
  // rather than twenty.
  const gateway = offline ? undefined : await createGatewayFromEnv();

  // `questionTargetsFromEnv` leaves `subgraphId` optional, because the env may
  // simply not have one. A slice cannot run without it. Casting that
  // uncertainty away would produce agents that hold a gateway, buy nothing and
  // report from priors — evidence-free answers that look exactly like
  // evidence-backed ones. So the fleet refuses to start instead.
  const envTargets = questionTargetsFromEnv();
  const subjectId = envTargets.subgraphId;
  if (!offline && !subjectId) {
    console.error(
      '\n  GRAPH_SUBJECT_SUBGRAPH is not set, so the agents would have nothing to read.\n' +
        '  Set it (with GRAPH_PEER_SUBGRAPHS and GRAPH_BRIDGE_SUBGRAPH), or run --offline.\n',
    );
    process.exit(1);
  }
  const targets = subjectId
    ? {
        subgraphId: subjectId,
        peerSubgraphIds: envTargets.peerSubgraphIds,
        ...(envTargets.bridgeSubgraphId ? { bridgeSubgraphId: envTargets.bridgeSubgraphId } : {}),
      }
    : undefined;

  const apiKey = readEnv(process.env, 'OPENAI_API_KEY');
  if (!offline && !apiKey) {
    console.error('\n  OPENAI_API_KEY is not set. Run with --offline to use a stub model.\n');
    process.exit(1);
  }
  const model = readEnv(process.env, 'OPENAI_MODEL');

  const servers: Server[] = [];
  const watchers: BondingWatcher[] = [];
  const rows: string[] = [];

  for (const [i, config] of pool.entries()) {
    const llm = offline
      ? offlineLlm(config.id)
      : openAiLlm({ apiKey: apiKey!, ...(model ? { model } : {}) });

    const agent = new Agent({
      config,
      llm,
      ...(gateway && targets ? { gateway, targets } : {}),
    });

    const { app, instanceId } = createAgentServer({ agent, config });
    const port = BASE_PORT + i;
    const endpoint = `http://127.0.0.1:${port}/report`;

    await new Promise<void>((resolve, reject) => {
      // The callback is wrapped rather than passed straight through: `listen`
      // has an overload whose second argument is an error callback, and
      // handing it `resolve` directly selects that one.
      const server = app.listen(port, () => resolve());
      server.on('error', reject);
      servers.push(server);
    });

    // Binding the port is not proof of owning it. A stale agent process from
    // an earlier run can still be listening, and on Windows this second bind
    // can succeed anyway — the fleet then reports every agent as up while the
    // OLD process quietly answers the market. That happened once and produced
    // a full green run served entirely by stubs. So each server is asked to
    // identify itself before its endpoint is published.
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      instanceId?: string;
    };
    if (health.instanceId !== instanceId) {
      throw new Error(
        `Port ${port} is answered by another process. Something from an earlier run is ` +
          `still listening — stop it, or set AGENT_BASE_PORT to a free range.`,
      );
    }

    // Registration is an ordinary open endpoint — no allowlist, no key. This
    // script is doing exactly what any third party's agent would do.
    //
    // FAILING TO REGISTER IS NOT FATAL. The fleet's job is to listen; being
    // known to a particular market is a separate thing, and some runs register
    // these agents from the other side — the on-chain gate brings up its own
    // API and registers the endpoints itself. An unreachable API here used to
    // throw out of the loop and take all twenty listening agents down with it,
    // which is the opposite of what a fleet should do.
    let status: string;
    try {
      // Signed with the same key that will sign this agent's reports and pay
      // its bonds. The API refuses a registration that cannot prove it holds
      // the key it registers.
      const claim = {
        agentId: config.id,
        accountId: config.accountId,
        publicKey: config.publicKey,
        endpoint,
        sliceIds: config.sliceIds,
        issuedAt: Date.now(),
      };
      const res = await fetch(`${API_URL}/agents/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...claim,
          signature: signRegistration(PrivateKey.fromStringECDSA(config.privateKey), claim),
        }),
      });
      status = res.ok ? 'registered' : `not registered (${res.status})`;
    } catch {
      status = 'listening, API unreachable';
    }

    // Each agent watches for markets and pays its own way in. Started only
    // after registration, because the orchestrator reaches an agent at the
    // endpoint it registered — bonding into a market this agent cannot then
    // be asked for a report would cost it the bond for nothing.
    if (bonding) {
      const watcher = new BondingWatcher({
        agent,
        agentId: config.id,
        apiUrl: API_URL,
        payingFetch: payingFetch(config.accountId, config.privateKey),
        maxBondTinybar: MAX_BOND_TINYBAR,
        onEvent: (event, detail) => console.log(`  [${event}]`, JSON.stringify(detail)),
      });
      watcher.start(Number(readEnv(process.env, 'AGENT_BOND_POLL_MS') ?? 4000));
      watchers.push(watcher);
    }

    rows.push(
      `  ${config.id}  :${port}  ${(config.behavior ?? 'honest').padEnd(6)} ` +
        `${status.padEnd(26)} ${config.sliceIds.join('+')}`,
    );
  }

  console.log('\nAGENT FLEET');
  console.log('='.repeat(74));
  console.log(`  API        ${API_URL}`);
  console.log(`  Model      ${offline ? 'offline stub' : `openai:${model ?? 'default'}`}`);
  console.log(`  Evidence   ${gateway ? 'The Graph gateway' : 'none (offline)'}`);
  console.log(
    `  Bonding    ${bonding ? `each agent pays its own, up to ${MAX_BOND_TINYBAR} tinybar` : 'off (--no-bond)'}`,
  );
  console.log(`  Subject    ${subjectId ?? 'NOT SET'}`);
  console.log('='.repeat(74));
  for (const row of rows) console.log(row);
  console.log('='.repeat(74));
  console.log(`  ${pool.length} agents listening. Ctrl-C to stop.\n`);

  const shutdown = (): void => {
    for (const w of watchers) w.stop();
    for (const s of servers) s.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((e) => {
  console.error(`\n  Fleet failed: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
