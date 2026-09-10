// @ethonline/api
// Orchestrator and x402-gated endpoints.

export {
  createApp,
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
  type StoredMarket,
} from './store.js';

export {
  createPaymentGate,
  hederaSpendControls,
  marketIdFromPath,
  payWithRetry,
  SETTLEMENT_HEADER,
  type PaymentGateOptions,
  type PayWithRetryOptions,
} from './payment.js';

export {
  Orchestrator,
  type AgentReportResponse,
  type AgentTransport,
  type OrchestratorDeps,
  type Payer,
  type PayerReceipt,
  type ReportRequest,
  type RoundResult,
  type SettlementResult,
} from './orchestrator.js';

export {
  assertPlanBalances,
  buildTransferPlan,
  chunkPlan,
  type PlanInput,
  type TransferLine,
  type TransferPlan,
} from './settlement-plan.js';

export { hederaPayer, httpAgentTransport, type HederaPayerOptions } from './transport.js';
