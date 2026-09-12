/**
 * Paying for a market from the browser, with a wallet.
 *
 * THE PRIVATE KEY NEVER ENTERS THIS PAGE. Everything else in this repo that
 * pays over x402 does it with a key out of `.env` — fine for a script on the
 * operator's machine, impossible here. Asking a visitor to paste a private key
 * into a web form is not a shortcut, it is the wrong product.
 *
 * WHAT MADE THIS POSSIBLE. `@x402/hedera` takes a `ClientHederaSigner`, which
 * is a plain object with two members:
 *
 *     { accountId, createPartiallySignedTransferTransaction(requirements) }
 *
 * `createClientHederaSigner(accountId, privateKey)` is only the default
 * factory for one. So a wallet-backed implementation drops straight in, and
 * the scheme, the facilitator and the server never know the difference.
 *
 * WHY THE TRANSACTION IS BUILT HERE AND NOT BY THE WALLET. The x402 "exact"
 * scheme settles a PARTIALLY signed transfer: the payer signs it, and the
 * facilitator adds the fee-payer signature and submits it. So the transaction
 * id belongs to the facilitator's account, not the payer's, and the payer must
 * sign without executing. `DAppSigner.signTransaction` returns the signed
 * transaction rather than submitting it, which is exactly that shape.
 *
 * The construction below mirrors the default signer field for field. It has
 * to: the facilitator verifies that the payer signed this exact frozen body,
 * so any difference shows up as "signature does not match" and sends whoever
 * debugs it looking at keys instead of at bytes.
 */
import { Buffer } from 'buffer';
import { DAppConnector } from '@hashgraph/hedera-wallet-connect/dist/lib/dapp';
import type { DAppSigner } from '@hashgraph/hedera-wallet-connect/dist/lib/dapp';
import {
  AccountId,
  Client,
  Hbar,
  LedgerId,
  TokenId,
  TransferTransaction,
  TransactionId,
} from '@hiero-ledger/sdk';
import { HBAR_ASSET_ID, HEDERA_TESTNET_CAIP2 } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';

/**
 * `Buffer`, because the payment stack expects Node and this is a browser.
 *
 * FOUND THE EXPENSIVE WAY. The wallet signed, the phone said success, and
 * nothing happened: `@x402/hedera` serialises the signed transaction with
 * `Buffer.from(...).toString('base64')`, and in a browser that global does not
 * exist. The failure lands AFTER the signature, so every visible sign says the
 * payment worked while no payment was ever sent — the worst possible place for
 * it to break.
 *
 * The alias in `vite.config.ts` makes `import 'buffer'` resolve; it does not
 * create the global, which is what library code written for Node reaches for.
 * Assigned here rather than in the app entry so it stays inside the wallet
 * chunk: a visitor who never pays should not download a polyfill.
 *
 * `??=` so a browser or extension that already provides one keeps it.
 */
const globalScope = globalThis as typeof globalThis & { Buffer?: typeof Buffer; global?: unknown };
globalScope.Buffer ??= Buffer;
globalScope.global ??= globalThis;

/**
 * A CAIP-2 network id, as `@x402/core` types it.
 *
 * Narrower than `string` on purpose: the library's own constraint, carried
 * through rather than cast away at the call site.
 */
type Caip2 = `${string}:${string}`;

/** What the 402 challenge asks for. Only the fields the signer needs. */
interface PaymentRequirementsLike {
  readonly network: string;
  readonly payTo: string;
  readonly asset: string;
  readonly amount: string;
  readonly extra?: { readonly feePayer?: unknown };
}

/**
 * A ceiling on any single payment, in tinybar.
 *
 * Not paranoia about this app: a wrapped fetch will pay whatever a 402 asks
 * for, and the whole point of connecting a wallet is that the money is real.
 * The deposit for a default market is about 1 HBAR, so 25 leaves room for
 * unusual parameters and still refuses anything absurd.
 */
export const DEFAULT_MAX_PAYMENT_TINYBAR = 2_500_000_000n;

/**
 * Wraps a connected wallet as the signer `@x402/hedera` expects.
 *
 * Mirrors `createClientHederaSigner`, with `tx.sign(privateKey)` replaced by a
 * round trip to the wallet.
 */
export function walletHederaSigner(
  signer: DAppSigner,
  accountId: string,
  network: Caip2 = HEDERA_TESTNET_CAIP2,
): {
  accountId: string;
  createPartiallySignedTransferTransaction(r: PaymentRequirementsLike): Promise<string>;
} {
  const payer = AccountId.fromString(accountId);

  return {
    accountId: payer.toString(),

    async createPartiallySignedTransferTransaction(
      requirements: PaymentRequirementsLike,
    ): Promise<string> {
      const feePayer = requirements.extra?.feePayer;
      if (typeof feePayer !== 'string') {
        throw new Error('The 402 challenge carried no feePayer, so nothing can be signed.');
      }
      const amount = BigInt(requirements.amount);
      if (amount <= 0n) throw new Error('The 402 challenge asked for a non-positive amount.');
      if (amount > DEFAULT_MAX_PAYMENT_TINYBAR) {
        throw new Error(
          `Refusing to sign ${amount} tinybar: above the ${DEFAULT_MAX_PAYMENT_TINYBAR} ceiling.`,
        );
      }

      const payTo = AccountId.fromString(requirements.payTo);
      const tx = new TransferTransaction();
      if (requirements.asset === HBAR_ASSET_ID) {
        tx.addHbarTransfer(payer, Hbar.fromTinybars((-amount).toString()));
        tx.addHbarTransfer(payTo, Hbar.fromTinybars(amount.toString()));
      } else {
        const tokenId = TokenId.fromString(requirements.asset);
        tx.addTokenTransfer(tokenId, payer, -amount);
        tx.addTokenTransfer(tokenId, payTo, amount);
      }

      // The facilitator pays the fee and submits, so the transaction id is
      // generated against ITS account. This is the part that looks wrong and
      // is not.
      tx.setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)));

      // `Client.forTestnet()` resolves to the SDK's WebClient in a browser
      // build. It performs no network call here — freezing only needs the
      // static node list — and the mirror channel it refuses to open is never
      // touched on this path.
      const client =
        requirements.network === HEDERA_TESTNET_CAIP2 ? Client.forTestnet() : Client.forMainnet();
      try {
        tx.freezeWith(client);
      } finally {
        client.close();
      }

      const signed = await signer.signTransaction(tx);
      return Buffer.from(signed.toBytes()).toString('base64');
    },
  };
}

/** A `fetch` that answers a 402 by asking the wallet to sign. */
export function payingFetch(
  signer: DAppSigner,
  accountId: string,
  network: Caip2 = HEDERA_TESTNET_CAIP2,
  maxAmountPerPayment: bigint = DEFAULT_MAX_PAYMENT_TINYBAR,
): typeof fetch {
  const scheme = new ExactHederaScheme(
    walletHederaSigner(signer, accountId, network) as never,
  );
  const paying = wrapFetchWithPayment(
    fetch,
    x402Client.fromConfig({
      schemes: [{ network, client: scheme }],
      // SPIKE A's trap, and it bites here too: the default controls allow only
      // "default assets", HBAR is not one, and an unconfigured client rejects
      // every Hedera payment with "All payment requirements were rejected by
      // spendControls" — which reads like a protocol error and is a config one.
      spendControls: {
        allowedAssets: [
          {
            network,
            asset: HBAR_ASSET_ID,
            maxAmountPerPayment: maxAmountPerPayment.toString(),
          },
        ],
      },
    }),
  ) as typeof fetch;

  /**
   * A narrating wrapper, because a failed payment in a browser is otherwise
   * mute.
   *
   * The 402 is the FIRST half of a working x402 exchange, so the browser logs
   * a red "402 Payment Required" line even when everything is fine. That makes
   * the console actively misleading: the interesting question is what happened
   * after it, and nothing was answering it. These lines do — the wallet round
   * trip either produced a second, paid request or threw, and both now say so
   * out loud with the amount and the account attached.
   */
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : String(input);
    console.info(`[x402] paying as ${accountId} on ${network}: ${url}`);
    try {
      const res = await paying(input as never, init as never);
      console.info(
        `[x402] finished with ${res.status}` +
          (res.status === 402
            ? ' — the wallet never produced a payment. The 402 above is the challenge; there was no paid retry.'
            : ''),
      );
      return res;
    } catch (e) {
      console.error(`[x402] payment failed before any retry: ${(e as Error).message}`, e);
      throw e;
    }
  }) as typeof fetch;
}

export interface WalletConnection {
  readonly connector: DAppConnector;
  readonly signer: DAppSigner;
  readonly accountId: string;
}

/**
 * Builds the connector.
 *
 * `projectId` is a WalletConnect/Reown project id. There is no way around it:
 * pairing goes through their relay, so without one the modal cannot open. It
 * is read from the environment rather than committed, and the UI says plainly
 * when it is missing instead of failing at the click.
 */
export function createConnector(projectId: string, testnet = true): DAppConnector {
  return new DAppConnector(
    {
      name: 'Self-resolving prediction markets',
      description: 'Ask a question no oracle can settle.',
      url: window.location.origin,
      icons: [`${window.location.origin}/favicon.ico`],
    },
    testnet ? LedgerId.TESTNET : LedgerId.MAINNET,
    projectId,
  );
}

/** Opens the wallet modal and returns the first account the user approved. */
export async function connectWallet(connector: DAppConnector): Promise<WalletConnection> {
  await connector.init({ logger: 'error' });
  await connector.openModal();

  const signer = connector.signers[0];
  if (!signer) {
    throw new Error('The wallet connected but exposed no account to sign with.');
  }
  return { connector, signer, accountId: signer.getAccountId().toString() };
}
