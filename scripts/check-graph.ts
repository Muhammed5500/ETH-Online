/**
 * The Graph Gateway check — the STEP 18 gate.
 *
 * Three things are verified, and only the third one can cost money:
 *
 *   1. The x402 challenge. Sends an UNPAID request to the gateway's x402
 *      endpoint with a plain fetch and decodes the 402 it comes back with,
 *      using this repo's own decoder. Free, and it proves the price the demo
 *      quotes is the price the gateway is actually asking for today.
 *
 *   2. The trap. Sends a request to the KEYED endpoint with no key and shows
 *      the gateway answering HTTP 200 with an auth error in the GraphQL body,
 *      then shows the client refusing to treat that as data. This is the
 *      failure mode that would otherwise reach an agent as "no evidence" and
 *      be reported as a probability anyway.
 *
 *   3. A real query, in whichever mode is configured. apikey mode is free.
 *      x402 mode spends real USDC on Base mainnet, so it is opt-in: pass
 *      `--pay` or nothing paid happens.
 *
 * Run:  pnpm check:graph          (free)
 *       pnpm check:graph --pay    (x402 mode: spends about $0.01)
 */
import './load-env.js';
import {
  GraphQueryError,
  PAYMENT_CHALLENGE_HEADER,
  createGatewayFromEnv,
  decodeChallenge,
  graphConfigFromEnv,
  GraphGateway,
  quoteFromChallenge,
  readEnv,
} from '@ethonline/graph';

/** Uniswap v3 on Ethereum. Public, heavily indexed, and not ours — a fair probe. */
const PROBE_SUBGRAPH = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';
const PROBE_QUERY = '{ _meta { block { number } } }';

let failures = 0;

function step(ok: boolean, name: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) console.log(`         ${detail}`);
}

function note(text: string): void {
  console.log(`         ${text}`);
}

async function checkChallenge(baseUrl: string): Promise<void> {
  console.log('\n1. x402 CHALLENGE (unpaid, free)\n' + '-'.repeat(70));

  const url = `${baseUrl}/api/x402/subgraphs/id/${PROBE_SUBGRAPH}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: PROBE_QUERY }),
  });

  step(res.status === 402, `Gateway asks for payment (HTTP ${res.status})`, url);

  const header = res.headers.get(PAYMENT_CHALLENGE_HEADER);
  step(
    header !== null,
    `Challenge arrives in the "${PAYMENT_CHALLENGE_HEADER}" header`,
    `body is ${(await res.text()).length} bytes — the challenge is NOT in it`,
  );
  if (!header) return;

  try {
    const challenge = decodeChallenge(header);
    const quote = quoteFromChallenge(challenge);
    step(true, `Decoded with our own decoder (x402 v${challenge.x402Version})`);
    note(`network  ${quote?.network}`);
    note(`asset    ${quote?.asset} (${quote?.symbol ?? 'unknown'})`);
    note(`amount   ${quote?.amountRaw} raw`);
    step(
      quote?.usd !== undefined,
      `Price resolves to a dollar figure`,
      quote?.usd !== undefined
        ? `$${quote.usd} per query`
        : 'asset not in KNOWN_ASSETS, so no figure is claimed',
    );
    const accept = challenge.accepts[0];
    note(`transfer ${String(accept?.extra?.['assetTransferMethod'])} (gasless: payer needs no ETH)`);
  } catch (e) {
    step(false, 'Decoded the challenge', (e as Error).message);
  }
}

async function checkAuthTrap(baseUrl: string): Promise<void> {
  console.log('\n2. THE HTTP 200 THAT IS A FAILURE\n' + '-'.repeat(70));

  const url = `${baseUrl}/api/subgraphs/id/${PROBE_SUBGRAPH}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: PROBE_QUERY }),
  });
  const body = (await res.text()).slice(0, 200);

  step(res.status === 200, `Unauthenticated query answers HTTP ${res.status}, not 401`, body);

  // Now the same answer, through the client. It must refuse it.
  const gateway = new GraphGateway({
    mode: 'apikey',
    apiKey: 'deliberately-wrong',
    fetchImpl: async () => new Response(body, { status: 200 }),
    retry: { attempts: 1 },
  });

  try {
    await gateway.query(PROBE_SUBGRAPH, PROBE_QUERY);
    step(false, 'Client refuses to read that as data', 'it returned successfully — bug');
  } catch (e) {
    const err = e as GraphQueryError;
    step(
      err.kind === 'graphql',
      `Client refuses to read that as data (kind: ${err.kind})`,
      err.message.slice(0, 160),
    );
    step(gateway.spend.queries === 0, 'Nothing was charged for it');
  }
}

async function checkRealQuery(paid: boolean): Promise<void> {
  console.log('\n3. A REAL QUERY\n' + '-'.repeat(70));

  let cfg;
  try {
    cfg = graphConfigFromEnv();
  } catch (e) {
    console.log(`  [SKIP] ${(e as Error).message}`);
    return;
  }

  if (cfg.mode === 'x402' && !paid) {
    console.log('  [SKIP] x402 mode spends real USDC on Base mainnet.');
    console.log('         Re-run with --pay to make one paid query (about $0.01).');
    return;
  }

  const gateway = await createGatewayFromEnv();
  console.log(`  mode: ${gateway.mode}`);
  console.log(`  url:  ${gateway.endpointFor(PROBE_SUBGRAPH)}`);

  try {
    const result = await gateway.query<{ _meta: { block: { number: number } } }>(
      PROBE_SUBGRAPH,
      PROBE_QUERY,
    );
    step(true, `Query returned data (block ${result.data._meta.block.number})`);
    note(`attempts   ${result.attempts}, ${result.durationMs} ms`);
    note(
      `cost       $${result.cost.usd ?? '?'} — ${result.cost.settled ? 'settled' : 'not settled'}` +
        `, ${result.cost.estimated ? 'estimated from the price list' : 'read from the receipt'}`,
    );
    if (result.paymentProof) note(`payment    ${result.paymentProof}`);
    if (result.attestation) note(`attested   ${result.attestation.slice(0, 60)}...`);
    console.log(`\n  spend so far: ${JSON.stringify(gateway.spend)}`);
  } catch (e) {
    const err = e as GraphQueryError;
    step(false, `Query failed (kind: ${err.kind ?? 'unknown'})`, err.message.slice(0, 300));
  }
}

async function main(): Promise<void> {
  const paid = process.argv.includes('--pay');
  const baseUrl = (readEnv(process.env, 'GRAPH_GATEWAY_URL') ?? 'https://gateway.thegraph.com')
    .replace(/\/+$/, '');

  console.log('\nTHE GRAPH GATEWAY CHECK\n' + '='.repeat(70));
  console.log(`gateway: ${baseUrl}`);
  console.log(`mode:    ${readEnv(process.env, 'GRAPH_GATEWAY_MODE') ?? '(unset, defaults to apikey)'}`);

  await checkChallenge(baseUrl);
  await checkAuthTrap(baseUrl);
  await checkRealQuery(paid);

  console.log('\n' + '='.repeat(70));
  console.log(failures === 0 ? 'ALL CHECKS PASSED\n' : `${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
