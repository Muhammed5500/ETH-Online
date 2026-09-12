// @ethonline/agent
// The agent runner: buy evidence, reason over it, produce a report (STEP 20),
// and the twenty-agent pool that keeps those reports independent (STEP 21).

export {
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_OPENAI_MODEL,
  JUDGEMENT_SCHEMA,
  openAiLlm,
  parseJudgement,
  stubLlm,
  type CreateCompletion,
  type Judgement,
  type JudgementRequest,
  type LlmClient,
  type OpenAiLlmOptions,
} from './llm.js';

export {
  Agent,
  buildSystemPrompt,
  buildUserPrompt,
  evidenceDigest,
  toBelief,
  type AgentBehavior,
  type AgentConfig,
  type AgentDeps,
  type PriorReport,
  type ProducedReport,
  type ReportInput,
} from './runner.js';

export {
  POOL_SLICE_IDS,
  buildAgentPool,
  buildPersona,
  sliceSubsets,
  type BuildPoolOptions,
  type PoolSliceId,
} from './pool.js';

export {
  createAgentServer,
  parseAgentKey,
  signReport,
  type AgentServer,
  type AgentServerDeps,
} from './server.js';
