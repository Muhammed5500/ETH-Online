// @ethonline/hedera
// Hedera SDK wrapper: accounts and treasury (STEP 12), HCS ledger (STEP 13),
// randomness (STEP 14), x402 payment rails (STEP 15).

export {
  agentCountFromEnv,
  hederaConfigFromEnv,
  parseNetwork,
  readEnv,
  treasuryFromEnv,
  type HederaConfig,
  type HederaNetwork,
  type KeyPairRef,
} from './env.js';

export { createHederaClient } from './client.js';

export {
  isTransientHederaError,
  withRetry,
  type RetryOptions,
} from './retry.js';

export {
  createAccount,
  getBalance,
  hashscanUrl,
  transfer,
  type Balance,
  type CreateAccountOptions,
  type NewAccount,
  type TransferOptions,
  type TransferResult,
} from './accounts.js';

export {
  ACCOUNTS_FILE_VERSION,
  agentIdFor,
  assertNetworkMatches,
  emptyAccountsFile,
  missingAgentIds,
  parseAccountsFile,
  serializeAccountsFile,
  setTreasury,
  upsertAgent,
  type AccountsFile,
  type AgentAccount,
} from './accounts-file.js';
