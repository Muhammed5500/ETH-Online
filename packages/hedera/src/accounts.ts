/**
 * Account operations: create, read a balance, move HBAR.
 *
 * Every write freezes its transaction before the first attempt so a retry
 * reuses the same transaction id and cannot double-spend. See `retry.ts`.
 */
import {
  AccountBalanceQuery,
  AccountCreateTransaction,
  AccountId,
  Hbar,
  PrivateKey,
  TransferTransaction,
  type Client,
} from '@hashgraph/sdk';
import { withRetry, type RetryOptions } from './retry.js';

export interface NewAccount {
  readonly accountId: string;
  readonly privateKey: string;
  readonly publicKey: string;
  /** Derived from the ECDSA public key. Recorded for later EVM-side work. */
  readonly evmAddress: string;
}

export interface CreateAccountOptions {
  /** Funded from the operator at creation time. */
  readonly initialBalanceHbar: number;
  readonly memo?: string;
  readonly retry?: RetryOptions;
}

/**
 * Creates a fresh ECDSA account.
 *
 * ECDSA rather than ED25519 to match the operator and to keep the door open
 * for anything EVM-flavoured later; the x402 Hedera signer works with either,
 * but a single key type across the system is one less thing to get wrong.
 */
export async function createAccount(
  client: Client,
  opts: CreateAccountOptions,
): Promise<NewAccount> {
  if (!(opts.initialBalanceHbar >= 0)) {
    throw new Error(`initialBalanceHbar must be >= 0, got: ${opts.initialBalanceHbar}`);
  }

  const privateKey = PrivateKey.generateECDSA();
  const publicKey = privateKey.publicKey;

  const tx = new AccountCreateTransaction()
    .setKeyWithoutAlias(publicKey)
    .setInitialBalance(new Hbar(opts.initialBalanceHbar));
  if (opts.memo) tx.setAccountMemo(opts.memo);

  // Frozen once, outside the retry, so every attempt carries one id.
  const frozen = tx.freezeWith(client);

  const receipt = await withRetry(async () => {
    const response = await frozen.execute(client);
    return response.getReceipt(client);
  }, opts.retry);

  const accountId = receipt.accountId;
  if (!accountId) {
    throw new Error(`Account creation returned no account id (status: ${receipt.status.toString()})`);
  }

  return {
    accountId: accountId.toString(),
    privateKey: privateKey.toStringDer(),
    publicKey: publicKey.toStringDer(),
    evmAddress: publicKey.toEvmAddress(),
  };
}

export interface Balance {
  readonly tinybar: bigint;
  readonly hbar: number;
}

/** Reads an account balance. A pure query, so retried freely. */
export async function getBalance(
  client: Client,
  accountId: string,
  retry?: RetryOptions,
): Promise<Balance> {
  const balance = await withRetry(
    () => new AccountBalanceQuery().setAccountId(AccountId.fromString(accountId)).execute(client),
    retry,
  );
  return {
    tinybar: BigInt(balance.hbars.toTinybars().toString()),
    hbar: balance.hbars.toBigNumber().toNumber(),
  };
}

export interface TransferOptions {
  readonly from: string;
  readonly to: string;
  readonly amountHbar: number;
  readonly memo?: string;
  /**
   * Required when `from` is not the client's operator — the sending account
   * has to sign for its own debit.
   */
  readonly fromKey?: string;
  readonly retry?: RetryOptions;
}

export interface TransferResult {
  readonly transactionId: string;
  readonly status: string;
}

/** Moves HBAR between two accounts. */
export async function transfer(client: Client, opts: TransferOptions): Promise<TransferResult> {
  if (!(opts.amountHbar > 0)) {
    throw new Error(`amountHbar must be > 0, got: ${opts.amountHbar}`);
  }
  if (opts.from === opts.to) {
    throw new Error(`Refusing a transfer from an account to itself (${opts.from}).`);
  }

  const amount = new Hbar(opts.amountHbar);
  const tx = new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(opts.from), amount.negated())
    .addHbarTransfer(AccountId.fromString(opts.to), amount);
  if (opts.memo) tx.setTransactionMemo(opts.memo);

  let frozen = tx.freezeWith(client);
  if (opts.fromKey) {
    frozen = await frozen.sign(PrivateKey.fromStringECDSA(opts.fromKey));
  }

  const signed = frozen;
  const { receipt, transactionId } = await withRetry(async () => {
    const response = await signed.execute(client);
    return { receipt: await response.getReceipt(client), transactionId: response.transactionId };
  }, opts.retry);

  return { transactionId: transactionId.toString(), status: receipt.status.toString() };
}

/** HashScan link for a transaction or account, for step logs and demos. */
export function hashscanUrl(
  network: string,
  kind: 'account' | 'transaction' | 'topic',
  id: string,
): string {
  return `https://hashscan.io/${network}/${kind}/${id}`;
}
