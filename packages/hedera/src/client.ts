/**
 * Hedera client factory.
 *
 * The retry policy lives in `retry.ts`, which imports no SDK — see the note
 * there on why retrying a payment is only safe with a frozen transaction.
 */
import { AccountId, Client, PrivateKey } from '@hashgraph/sdk';
import type { HederaConfig } from './env.js';

/** Builds a configured client. The caller owns it and must `close()` it. */
export function createHederaClient(cfg: HederaConfig): Client {
  const client =
    cfg.network === 'mainnet'
      ? Client.forMainnet()
      : cfg.network === 'previewnet'
        ? Client.forPreviewnet()
        : cfg.network === 'local'
          ? Client.forNetwork({ '127.0.0.1:50211': new AccountId(3) })
          : Client.forTestnet();

  // Explicitly ECDSA. `PrivateKey.fromString` guesses between ECDSA and
  // ED25519 and can guess wrong, then fail later with an unrelated-looking
  // signature error (noted during the STEP 2 preflight).
  client.setOperator(
    AccountId.fromString(cfg.operatorId),
    PrivateKey.fromStringECDSA(cfg.operatorKey),
  );
  return client;
}

export { isTransientHederaError, withRetry, type RetryOptions } from './retry.js';
