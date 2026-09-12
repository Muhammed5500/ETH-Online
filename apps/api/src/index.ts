// @ethonline/api
// Orchestrator and x402-gated endpoints.

export {
  createApp,
  errorHandler,
  isUpstreamFailure,
  DEFAULT_API_CONFIG,
  publicMarketView,
  resolveParams,
  resolvePrior,
  type Api,
  type ApiConfig,
  type AppDeps,
} from './app.js';

export { hederaLedger, type Ledger, type LedgerAppend } from './ledger.js';

export {
  createMemoryLedger,
  memoryRunningHash,
  type MemoryLedger,
  type MemoryLedgerOptions,
} from './memory-ledger.js';

export {
  bondTinybar,
  DEFAULT_HBAR_PER_UNIT,
  DEFAULT_RESOLVE_PRICE_TINYBAR,
  depositTinybar,
  formatTinybar,
  TINYBAR_PER_HBAR,
  tinybarToHbar,
  unitsToTinybar,
} from './pricing.js';

export {
  canonicalRegistrationMessage,
  registrationMessageBytes,
  REGISTRATION_MAX_AGE_MS,
  REGISTRATION_SIGNATURE_DOMAIN,
  REGISTRATION_SIGNATURE_VERSION,
  verifyRegistrationSignature,
  type RegistrationClaim,
} from './signatures.js';

export {
  canonicalReportMessage,
  REPORT_SIGNATURE_DOMAIN,
  REPORT_SIGNATURE_VERSION,
  reportMessageBytes,
  verifyReportSignature,
  type ReportClaim,
} from './signatures.js';

export {
  AgentRegistry,
  MarketStore,
  nextMarketId,
  type BondRecord,
  type RegisteredAgent,
  type ReportAnnotation,
  type StoredMarket,
} from './store.js';

export {
  logRollback,
  onPaymentFailure,
  withPaymentRollback,
  type RollbackOptions,
  type RollbackReport,
} from './payment-rollback.js';

export {
  createPaymentGate,
  DEFAULT_FACILITATOR_TIMEOUT_MS,
  hederaSpendControls,
  marketIdFromPath,
  isPaidRoute,
  onlyPaidRoutes,
  payWithRetry,
  SETTLEMENT_HEADER,
  warmUpFacilitator,
  withFacilitatorErrors,
  type PaymentGateOptions,
  type PayWithRetryOptions,
} from './payment.js';

export {
  Orchestrator,
  SettlementBlockedError,
  type AgentReportResponse,
  type AgentTransport,
  type OrchestratorDeps,
  type Payer,
  type PayerReceipt,
  type ReportRequest,
  type RoundResult,
  type SettlementResult,
} from './orchestrator.js';

export { MarketRunner, type MarketRunnerDeps, type RunOutcome } from './runner.js';

export { agentRecords, recordFor, type AgentRecord } from './reputation.js';

export {
  assertPlanBalances,
  buildRefundPlan,
  buildTransferPlan,
  chunkPlan,
  type PlanInput,
  type RefundInput,
  type TransferLine,
  type TransferPlan,
} from './settlement-plan.js';

export {
  chunkAmount,
  createProgress,
  describeProgress,
  nextChunks,
  resolveChunk,
  summarize,
  type ChunkRecord,
  type ChunkState,
  type ProgressSummary,
  type SettlementProgress,
} from './settlement-progress.js';

export { hederaPayer, httpAgentTransport, type HederaPayerOptions } from './transport.js';

export {
  buildResolveAnswer,
  findAnsweredMarket,
  findPendingMarket,
  questionKey,
  type AgentBreakdownEntry,
  type BuildAnswerOptions,
  type ResolveAnswer,
} from './resolve.js';
