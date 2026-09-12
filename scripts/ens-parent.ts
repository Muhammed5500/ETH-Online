/**
 * Registers the parent name the agent subnames will live under — ADIM 24, part one.
 *
 * WHAT THIS BUYS AND WHAT IT COSTS. A `.eth` name on ENSv2 Sepolia, for one
 * year, paid in the deployment's mock stablecoin rather than in ether. Sepolia
 * ETH is only ever gas here; the 8 USDC price comes out of a token whose mint
 * is open to anyone on this testnet, which the script tops up if the balance
 * is short.
 *
 * COMMIT AND REVEAL, AND THE WAIT IN THE MIDDLE. Registration is two
 * transactions with a minimum age between them, so a watcher cannot see a name
 * in the mempool and register it first. The wait is real time — a minute on
 * this deployment — and the script sits through it rather than pretending to
 * be quick.
 *
 * IDEMPOTENT. Run it twice and the second run reports that the name is taken
 * and by whom. It never re-registers, because a second registration of a name
 * we already own would burn the fee to change nothing.
 *
 * Run:  pnpm ens:parent
 */
import './load-env.js';
import { formatUnits, parseAbi, parseUnits, type Address } from 'viem';
import { orchestratorSigner, ONE_YEAR_SECONDS, SEPOLIA } from '@ethonline/ens';
import { readEnv } from '@ethonline/hedera';

const REGISTRAR_ABI = parseAbi([
  'function isAvailable(string label) view returns (bool)',
  'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256)',
  'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)',
  'function commit(bytes32 commitment)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)',
  'function MIN_COMMITMENT_AGE() view returns (uint256)',
]);

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
]);

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const ZERO32 = `0x${'00'.repeat(32)}` as const;

function randomSecret(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const parent = readEnv(process.env, 'ENS_PARENT_NAME');
  if (!parent) {
    console.error('\n  ENS_PARENT_NAME is not set. Put the full name in .env, e.g. unverifiable.eth\n');
    process.exit(1);
  }
  const label = parent.replace(/\.eth$/, '');
  if (label.includes('.')) {
    console.error(`\n  ${parent} is not a second-level .eth name; this registrar only sells those.\n`);
    process.exit(1);
  }

  const { address, wallet, publicClient } = orchestratorSigner();
  const registrar = SEPOLIA.ethRegistrar;
  const token = SEPOLIA.paymentToken;

  console.log('\nENS PARENT NAME');
  console.log('='.repeat(66));
  console.log(`  Name        ${label}.eth`);
  console.log(`  Owner       ${address}  (the Hedera operator key on Sepolia)`);
  console.log(`  Registrar   ${registrar}`);
  console.log('='.repeat(66));

  const gas = await publicClient.getBalance({ address });
  console.log(`  Gas balance ${formatUnits(gas, 18)} ETH`);
  if (gas === 0n) {
    console.error('\n  No Sepolia ETH at that address. Nothing can be sent.\n');
    process.exit(1);
  }

  const available = await publicClient.readContract({
    address: registrar,
    abi: REGISTRAR_ABI,
    functionName: 'isAvailable',
    args: [label],
  });
  if (!available) {
    console.log(`\n  ${label}.eth is already registered. Nothing to do.`);
    console.log('  If it is not yours, pick another ENS_PARENT_NAME.\n');
    return;
  }

  const price = await publicClient.readContract({
    address: registrar,
    abi: REGISTRAR_ABI,
    functionName: 'getRegisterPrice',
    args: [label, ONE_YEAR_SECONDS, token],
  });
  console.log(`  Price       ${formatUnits(price, SEPOLIA.paymentTokenDecimals)} test USDC for one year`);

  // ---- the fee, in a token rather than ether -----------------------------
  let balance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address],
  });
  if (balance < price) {
    const amount = parseUnits('100', SEPOLIA.paymentTokenDecimals);
    console.log(`\n  Minting ${formatUnits(amount, SEPOLIA.paymentTokenDecimals)} test USDC (mint is open on this deployment) ...`);
    const hash = await wallet.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'mint',
      args: [address, amount],
      chain: wallet.chain,
      account: wallet.account!,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    balance = await publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address],
    });
    console.log(`  balance now ${formatUnits(balance, SEPOLIA.paymentTokenDecimals)}  ${hash}`);
  }

  const allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [address, registrar],
  });
  if (allowance < price) {
    console.log('\n  Approving the registrar to take the fee ...');
    const hash = await wallet.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [registrar, balance],
      chain: wallet.chain,
      account: wallet.account!,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  approved    ${hash}`);
  }

  // ---- commit ------------------------------------------------------------
  //
  // The secret is generated here and used again below. It never leaves this
  // process: the commitment is a hash, so the chain learns the name only at
  // the reveal, which is the entire point of the two-step flow.
  const secret = randomSecret();
  const commitArgs = [label, address as Address, secret, ZERO, ZERO, ONE_YEAR_SECONDS, ZERO32] as const;
  const commitment = await publicClient.readContract({
    address: registrar,
    abi: REGISTRAR_ABI,
    functionName: 'makeCommitment',
    args: commitArgs,
  });

  console.log('\n  Committing ...');
  const commitHash = await wallet.writeContract({
    address: registrar,
    abi: REGISTRAR_ABI,
    functionName: 'commit',
    args: [commitment],
    chain: wallet.chain,
    account: wallet.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash: commitHash });
  console.log(`  committed   ${commitHash}`);

  const minAge = await publicClient.readContract({
    address: registrar,
    abi: REGISTRAR_ABI,
    functionName: 'MIN_COMMITMENT_AGE',
  });
  // A few seconds over the minimum: the check is against block timestamps, and
  // landing exactly on the boundary fails for the least interesting reason.
  const waitMs = Number(minAge) * 1000 + 15_000;
  console.log(`  Waiting ${Math.round(waitMs / 1000)}s for the commitment to age ...`);
  await sleep(waitMs);

  // ---- reveal ------------------------------------------------------------
  console.log('\n  Registering ...');
  const registerHash = await wallet.writeContract({
    address: registrar,
    abi: REGISTRAR_ABI,
    functionName: 'register',
    args: [label, address as Address, secret, ZERO, ZERO, ONE_YEAR_SECONDS, token, ZERO32],
    chain: wallet.chain,
    account: wallet.account!,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: registerHash });
  console.log(`  registered  ${registerHash}  (${receipt.status})`);

  const stillFree = await publicClient.readContract({
    address: registrar,
    abi: REGISTRAR_ABI,
    functionName: 'isAvailable',
    args: [label],
  });

  console.log('='.repeat(66));
  console.log(`  ${label}.eth ${stillFree ? 'IS STILL AVAILABLE — the registration did not take' : 'is registered'}`);
  console.log(`  https://sepolia.etherscan.io/tx/${registerHash}`);
  console.log('='.repeat(66) + '\n');
  if (stillFree) process.exit(1);
}

main().catch((e) => {
  console.error(`\n  ENS parent registration failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
