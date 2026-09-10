/**
 * Scaffolding for the testnet end-to-end test.
 *
 * Everything here talks to the real network. It is separate from the unit
 * helpers so that nothing in `pnpm test` can accidentally reach for a key or a
 * facilitator.
 *
 * `scripts/check-orchestrator.ts` does much the same thing with narration
 * instead of assertions. The duplication is deliberate: the script is the
 * human-facing gate for a demo, this is the machine-facing one, and coupling
 * them would make each worse at its job.
 */
// Loads the repo-root .env. Scripts get this by importing the package too;
// vitest starts from the repo root but never loads dotenv on its own.
import '@ethonline/env';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import {
  createClientHederaSigner,
  ExactHederaScheme,
  HBAR_ASSET_ID,
  HEDERA_TESTNET_CAIP2,
  PrivateKey,
} from '@x402/hedera';
import type { MarketParams } from '@ethonline/core';
import {
  createHederaClient,
  hederaConfigFromEnv,
  parseAccountsFile,
  readEnv,
  treasuryFromEnv,
  type AgentAccount,
  type HederaConfig,
  type KeyPairRef,
} from '@ethonline/hedera';
import type { Client } from '@hashgraph/sdk';
import { createApp, DEFAULT_API_CONFIG } from '../src/app.js';
import { hederaLedger } from '../src/ledger.js';
import { createPaymentGate, payWithRetry, warmUpFacilitator } from '../src/payment.js';
import { MarketStore, AgentRegistry } from '../src/store.js';
import { canonicalReportMessage } from '../src/signatures.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

export interface Credentials {
  readonly cfg: HederaConfig;
  readonly treasury: KeyPairRef;
  readonly agents: readonly AgentAccount[];
}

/**
 * Loads everything the test needs, or returns null.
 *
 * Returning null rather than throwing lets the suite skip cleanly on a machine
 * with no `.env` — an integration test that cannot run is not a failure.
 */
export function loadCredentials(): Credentials | null {
  try {
    const cfg = hederaConfigFromEnv();
    const treasury = treasuryFromEnv();
    if (!treasury) return null;
    const accounts = parseAccountsFile(
      readFileSync(join(REPO_ROOT, 'agents', 'accounts.json'), 'utf-8'),
    );
    if (accounts.agents.length === 0) return null;
    return { cfg, treasury, agents: accounts.agents };
  } catch {
    return null;
  }
}

/** A fetch that pays x402 invoices from one Hedera account. */
export function payingFetch(accountId: string, privateKey: string, ceilingTinybar: bigint) {
  const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), {
    network: HEDERA_TESTNET_CAIP2,
  });
  return wrapFetchWithPayment(
    fetch,
    x402Client.fromConfig({
      schemes: [{ network: HEDERA_TESTNET_CAIP2, client: new ExactHederaScheme(signer) }],
      // HBAR is not a "default asset"; without this the client refuses every
      // payment before it is attempted (SPIKE A).
      spendControls: {
        allowedAssets: [
          {
            network: HEDERA_TESTNET_CAIP2,
            asset: HBAR_ASSET_ID,
            maxAmountPerPayment: ceilingTinybar.toString(),
          },
        ],
      },
    }),
  );
}

export interface AgentServerOptions {
  readonly accounts: readonly AgentAccount[];
  readonly port: number;
  /** Agents named here never answer, so the timeout path can be exercised. */
  readonly silent?: ReadonlySet<string>;
}

/** One server hosting every agent, each signing with its own Hedera key. */
export function startAgentServer(opts: AgentServerOptions): Promise<Server> {
  const app = express();
  app.use(express.json());

  for (const account of opts.accounts) {
    const key = PrivateKey.fromStringECDSA(account.privateKey);
    app.post(`/${account.agentId}`, (req, res) => {
      if (opts.silent?.has(account.agentId)) {
        // Never answers. The orchestrator's deadline has to do the work.
        return;
      }
      const { marketId, position, history } = req.body as {
        marketId: string;
        position: number;
        history: Array<{ belief: [number, number] }>;
      };
      const seed = account.accountId.charCodeAt(account.accountId.length - 1);
      const signal = 0.45 + ((seed * 11) % 40) / 100;
      const price = history.length ? history[history.length - 1]!.belief[1] : 0.5;
      const probability = Number((0.6 * price + 0.4 * signal).toFixed(6));

      const message = canonicalReportMessage({
        marketId,
        agentId: account.agentId,
        position,
        belief: [1 - probability, probability],
      });
      const signature = Buffer.from(
        key.sign(new Uint8Array(Buffer.from(message, 'utf-8'))),
      ).toString('hex');
      res.json({ probability, signature });
    });
  }

  return new Promise((resolve) => {
    const s = app.listen(opts.port, () => resolve(s));
  });
}

export interface ApiHarness {
  readonly base: string;
  readonly server: Server;
  readonly markets: MarketStore;
  readonly registry: AgentRegistry;
  readonly client: Client;
  close(): void;
}

export async function startApi(
  creds: Credentials,
  port: number,
  defaultParams: MarketParams,
): Promise<ApiHarness> {
  const client = createHederaClient(creds.cfg);
  const markets = new MarketStore();
  const registry = new AgentRegistry();

  const facilitatorUrl =
    readEnv(process.env, 'BLOCKY402_FACILITATOR_URL') ?? 'https://api.testnet.blocky402.com';
  // Pay the cold-start here rather than inside the first paid request, where
  // it can exceed the x402 client's ten-second initialisation budget.
  await warmUpFacilitator(facilitatorUrl);

  const { app } = createApp({
    ledger: hederaLedger(client),
    markets,
    registry,
    paymentGate: createPaymentGate({
      treasuryAccountId: creds.treasury.accountId,
      facilitatorUrl,
      facilitatorTimeoutMs: Number(readEnv(process.env, 'FACILITATOR_TIMEOUT_MS') ?? 45_000),
      markets,
      defaultParams,
      hbarPerUnit: DEFAULT_API_CONFIG.hbarPerUnit,
    }),
    config: { network: creds.cfg.network },
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });

  return {
    base: `http://localhost:${port}`,
    server,
    markets,
    registry,
    client,
    close() {
      server.close();
      client.close();
    },
  };
}

export async function registerAgents(
  base: string,
  accounts: readonly AgentAccount[],
  agentPort: number,
): Promise<void> {
  for (const a of accounts) {
    const publicKey = PrivateKey.fromStringECDSA(a.privateKey).publicKey.toStringDer();
    const res = await fetch(`${base}/agents/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: a.agentId,
        accountId: a.accountId,
        publicKey,
        endpoint: `http://localhost:${agentPort}/${a.agentId}`,
      }),
    });
    if (res.status !== 201) {
      throw new Error(`Registering ${a.agentId} failed with ${res.status}`);
    }
  }
}

/** Every agent posts its own bond, retrying a transient 402. */
export async function bondAll(
  base: string,
  marketId: string,
  accounts: readonly AgentAccount[],
  markets: MarketStore,
): Promise<void> {
  for (const a of accounts) {
    const f = payingFetch(a.accountId, a.privateKey, 200_000_000n);
    const res = await payWithRetry(
      () =>
        f(`${base}/market/${marketId}/bond`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: a.agentId }),
        }),
      { alreadyDone: async () => markets.get(marketId)!.bonds.has(a.agentId) },
    );
    if (res.status !== 201 && !markets.get(marketId)!.bonds.has(a.agentId)) {
      throw new Error(`Bond for ${a.agentId} failed with ${res.status}`);
    }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
