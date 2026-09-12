/**
 * One container, both halves: the API and the agent fleet.
 *
 * WHY TOGETHER. The orchestrator reaches an agent by POSTing to the endpoint
 * that agent registered. Split across two hosts that means public addresses,
 * private networking, or a tunnel; in one container it means `127.0.0.1` and
 * nothing to configure. The agents are still twenty separate HTTP servers with
 * twenty separate keys — what is shared is the machine, not the process's idea
 * of who they are.
 *
 * This is a deployment convenience and not a property of the protocol. An
 * agent somewhere else, run by somebody else, joins exactly the same way: it
 * registers an endpoint the orchestrator can reach and pays its own bonds.
 *
 * ORDER MATTERS. The fleet registers with the API at startup and does not
 * retry forever, so the API has to be answering before the fleet begins. This
 * waits for `/health` rather than sleeping a hopeful number of seconds.
 *
 * KEYS ARRIVE AS AN ENVIRONMENT VARIABLE. `agents/accounts.json` holds twenty
 * private keys and is not in the repository. On a host, the file is written at
 * boot from `AGENTS_ACCOUNTS_B64` — base64 of the same file — so the keys live
 * in the platform's secret store rather than in an image layer.
 *
 * Run:  pnpm start:all
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PORT = Number(process.env['PORT'] ?? process.env['API_PORT'] ?? 4020);
const ACCOUNTS_PATH = join(ROOT, 'agents', 'accounts.json');

/** Writes the accounts file from the environment, when the host supplies one. */
function materialiseAccounts(): 'file' | 'env' | 'missing' {
  if (existsSync(ACCOUNTS_PATH)) return 'file';
  const encoded = process.env['AGENTS_ACCOUNTS_B64'];
  if (!encoded) return 'missing';
  const json = Buffer.from(encoded, 'base64').toString('utf-8');
  // Parsed before it is written: a truncated or wrongly-encoded secret should
  // fail here with a clear message, not thirty seconds later inside the fleet.
  const parsed = JSON.parse(json) as { agents?: unknown[] };
  if (!Array.isArray(parsed.agents) || parsed.agents.length === 0) {
    throw new Error('AGENTS_ACCOUNTS_B64 decoded to something with no agents in it.');
  }
  mkdirSync(dirname(ACCOUNTS_PATH), { recursive: true });
  writeFileSync(ACCOUNTS_PATH, json);
  console.log(`[start] wrote agents/accounts.json from the environment (${parsed.agents.length} agents)`);
  return 'env';
}

function run(name: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = (line: string): string => `[${name}] ${line}`;
  child.stdout?.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) if (line.trim()) console.log(prefix(line));
  });
  child.stderr?.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n')) if (line.trim()) console.error(prefix(line));
  });
  return child;
}

/** tsx, resolved from this install rather than assumed to be on PATH. */
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

async function waitForApi(timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return true;
    } catch {
      // Not up yet. The API opens a Hedera client and warms the facilitator
      // before it listens, so a cold start is tens of seconds, not one.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main(): Promise<void> {
  const accounts = materialiseAccounts();
  const runFleet = accounts !== 'missing' && process.env['SKIP_FLEET'] !== '1';

  console.log('');
  console.log('ethonline — API and fleet in one process tree');
  console.log('='.repeat(64));
  console.log(`  Port      ${PORT}`);
  console.log(`  Accounts  ${accounts === 'missing' ? 'NONE — the fleet will not start' : accounts}`);
  console.log(`  Fleet     ${runFleet ? 'starting after the API answers' : 'disabled'}`);
  console.log('='.repeat(64));

  const api = run('api', [TSX, 'apps/api/src/server.ts'], {});
  const children: ChildProcess[] = [api];

  if (runFleet) {
    const ready = await waitForApi();
    if (!ready) {
      console.error('[start] the API never answered /health; not starting the fleet.');
    } else {
      children.push(
        run('fleet', [TSX, 'scripts/agent-fleet.ts'], {
          API_URL: `http://127.0.0.1:${PORT}`,
        }),
      );
    }
  } else if (accounts === 'missing') {
    console.error(
      '[start] agents/accounts.json is absent and AGENTS_ACCOUNTS_B64 is not set. ' +
        'The API runs; nothing will bond, so markets will sit at bonding until the window ' +
        'closes and then be cancelled and refunded.',
    );
  }

  // If either half dies the whole thing should die, so the platform restarts a
  // known state instead of leaving an API with no agents or a fleet with no
  // API — both of which look alive and answer nothing useful.
  for (const child of children) {
    child.on('exit', (code, signal) => {
      console.error(`[start] a child exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}); shutting down.`);
      for (const other of children) if (other !== child) other.kill('SIGTERM');
      process.exit(code ?? 1);
    });
  }

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`[start] ${signal}, stopping.`);
    for (const child of children) child.kill(signal);
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(`[start] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
