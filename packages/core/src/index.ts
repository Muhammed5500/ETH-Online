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
  deviationBound,
  kMinApprox,
  kMinStrict,
  signalSpread,
} from './kcalc.js';

export {
  clipBelief,
  clipToAllowedMove,
  crossEntropy,
  kl,
  maxTotalPayout,
  moveLimits,
  scoreCE,
  scoreCEM,
  totalCEM,
  worstCaseLoss,
} from './scoring.js';

export {
  assertSettlementInvariants,
  computeSettlement,
  requiredDeposit,
  type SettlementOptions,
} from './settlement.js';

export { createMarketState, Market, type CreateMarketOptions } from './market.js';
