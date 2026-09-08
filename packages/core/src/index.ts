// @ethonline/core
// SKC self-resolving prediction market mekanizması.
// Saf TypeScript: ağ, dosya ve ortam değişkeni erişimi yok.

export type {
  Belief,
  ClosedReason,
  MarketParams,
  MarketState,
  MarketStatus,
  Payout,
  RandomSource,
  Report,
  Settlement,
} from './types.js';

export {
  assertValidParams,
  beliefFromProbability,
  DEFAULT_PARAMS,
  flatFeeProbability,
  normalizeBelief,
  poolExhaustionProbability,
  probabilityOfYes,
  suggestedAlpha,
  UNIFORM_PRIOR,
  validateParams,
  type ValidationResult,
} from './config.js';

export {
  clipBelief,
  crossEntropy,
  kl,
  maxTotalPayout,
  scoreCE,
  scoreCEM,
  totalCEM,
} from './scoring.js';

export { createMarketState, Market, type CreateMarketOptions } from './market.js';
