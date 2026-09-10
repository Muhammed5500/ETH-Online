// @ethonline/graph
// The Graph Gateway client (STEP 18) and the per-agent data slices (STEP 19).
//
// This is the evidence layer. Every agent buys its own inputs here and the
// resulting report decides who gets paid, so a query that quietly returns
// nothing is a market scored on evidence that never existed.

export {
  DEFAULT_GATEWAY_URL,
  DEFAULT_LIST_PRICE_USD,
  DEFAULT_TIMEOUT_MS,
  GraphGateway,
  isDeploymentId,
  parseRetryAfter,
  type FetchLike,
  type GatewayConfig,
  type GatewayMode,
  type GatewayRetryOptions,
  type QueryCost,
  type QueryResult,
  type SpendRecord,
  type SpendSummary,
} from './gateway.js';

export { GraphQueryError, type GraphErrorDetail, type GraphErrorKind } from './errors.js';

export {
  ATTESTATION_HEADER,
  KNOWN_ASSETS,
  PAYMENT_CHALLENGE_HEADER,
  PAYMENT_SETTLEMENT_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  amountToDecimal,
  assetKey,
  decodeChallenge,
  decodeSettlement,
  lookupAsset,
  quoteFromChallenge,
  type KnownAsset,
  type QuotedPrice,
  type X402Accept,
  type X402Challenge,
  type X402Settlement,
} from './x402.js';

export {
  X402_CHAIN_IDS,
  assertPrivateKey,
  createX402Fetch,
  type X402Chain,
  type X402FetchOptions,
} from './x402-fetch.js';

export {
  createGatewayFromEnv,
  graphConfigFromEnv,
  parseChain,
  parseMode,
  questionTargetsFromEnv,
  readEnv,
  type GatewayFromEnvOptions,
  type GraphEnvConfig,
  type QuestionTargets,
} from './env.js';

export {
  ACTIVITY_QUERY,
  ALL_SLICES,
  BRIDGE_QUERY,
  COMPARATIVE_QUERY,
  DEFAULT_WINDOW_DAYS,
  HOLDERS_QUERY,
  LIQUIDITY_QUERY,
  SLICE_IDS,
  activitySlice,
  bridgeSlice,
  buildSummary,
  coefficientOfVariation,
  comparativeSlice,
  formatSignal,
  getSlice,
  herfindahl,
  holdersSlice,
  hourConcentration,
  interArrivalGaps,
  liquiditySlice,
  mean,
  median,
  nonNegative,
  num,
  oneShotShare,
  percentileRank,
  profileFrom,
  ratio,
  round,
  roundNumberShare,
  signal,
  sum,
  sumByKey,
  topNShare,
  uniqueCount,
  windowStart,
  type DataSlice,
  type ProtocolProfile,
  type QuestionContext,
  type SliceEvidence,
  type SliceSignal,
} from './slices/index.js';
