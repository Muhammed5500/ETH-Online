/**
 * The model behind an agent's judgement.
 *
 * ONE INTERFACE, AND WHY IT EARNS ITS KEEP. Two reasons, both concrete:
 * `pnpm test` must never reach the network, so every test needs a stub here;
 * and PLAN.md specifies `claude-sonnet-5` while this build runs OpenAI, so the
 * provider is a thing that has already changed once. The abstraction is one
 * function type, which is about as cheap as an abstraction gets.
 *
 * STRUCTURED OUTPUT IS NOT A CONVENIENCE. The mechanism scores a number. If
 * that number has to be scraped out of prose, the failure mode is not "the
 * agent was vague" — it is a parse error at the moment an agent is drawn,
 * which costs it the bond and takes a report out of the market. So the model
 * is pinned to a JSON schema and the probability arrives typed.
 *
 * The model is never asked to clip. It reports what it believes and the
 * protocol clips to [epsilon, 1-epsilon] and to the bond's move limit
 * (core/market.ts). An agent that pre-clips hides its own opinion from the
 * audit trail, and the raw value is exactly what makes the clip checkable.
 */

/** What the model is asked to produce. Nothing else is scored. */
export interface Judgement {
  /** P(Y=1) in [0, 1], UNCLIPPED. The protocol clips; the agent must not. */
  readonly probability: number;
  /** Why, in the agent's own words. Displayed, never signed, never scored. */
  readonly reasoning: string;
}

export interface JudgementRequest {
  readonly question: string;
  /** The agent's persona and its instructions. */
  readonly system: string;
  /** Evidence summaries, prior reports, everything the agent may see. */
  readonly user: string;
}

/** Injected everywhere. A stub in tests, OpenAI in production. */
export interface LlmClient {
  readonly name: string;
  judge(req: JudgementRequest): Promise<Judgement>;
}

/** The schema the model must answer in. */
export const JUDGEMENT_SCHEMA = {
  type: 'object',
  properties: {
    probability: {
      type: 'number',
      description:
        'Probability that the answer to the question is YES, between 0 and 1. ' +
        'Report your honest belief. Do NOT round to 0 or 1.',
    },
    reasoning: {
      type: 'string',
      description:
        'Two to four sentences. Cite the specific derived figures you relied on ' +
        'and say how the earlier reports moved you, if they did.',
    },
  },
  required: ['probability', 'reasoning'],
  additionalProperties: false,
} as const;

export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

export interface OpenAiLlmOptions {
  readonly apiKey: string;
  readonly model?: string;
  /** Injected in tests. Defaults to the real OpenAI client. */
  readonly createCompletion?: CreateCompletion;
  readonly timeoutMs?: number;
}

/** The one call we make, narrowed so a test can supply it without the SDK. */
export type CreateCompletion = (args: {
  model: string;
  system: string;
  user: string;
  timeoutMs: number;
}) => Promise<string>;

export const DEFAULT_LLM_TIMEOUT_MS = 45_000;

/**
 * Reads a model's answer.
 *
 * Exported because it is the part most likely to be wrong in a way tests must
 * pin: a model that answers `{"probability": "0.7"}` or returns a percentage
 * is a real occurrence, and both are silent corruptions of a scored value if
 * they are coerced quietly. Neither is accepted here.
 */
export function parseJudgement(raw: string): Judgement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Model did not return JSON: ${raw.slice(0, 200)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Model returned ${typeof parsed}, expected an object.`);
  }
  const obj = parsed as Record<string, unknown>;

  const p = obj['probability'];
  if (typeof p !== 'number' || !Number.isFinite(p)) {
    throw new Error(
      `"probability" must be a finite number, got ${JSON.stringify(p)}. ` +
        `A string here would coerce to a plausible-looking number and be scored.`,
    );
  }
  if (p < 0 || p > 1) {
    throw new Error(
      `"probability" must be in [0, 1], got ${p}. A model answering on a 0-100 ` +
        `scale is the common cause, and 72 clipped to 0.99 would look like conviction.`,
    );
  }

  const reasoning = obj['reasoning'];
  return {
    probability: p,
    reasoning: typeof reasoning === 'string' ? reasoning : '',
  };
}

/**
 * The OpenAI-backed client.
 *
 * The SDK is imported lazily so that merely importing this module — which
 * every test of the runner does — neither loads the package nor requires a
 * key. Tests pass `createCompletion` and never reach this path.
 */
export function openAiLlm(opts: OpenAiLlmOptions): LlmClient {
  const model = opts.model ?? DEFAULT_OPENAI_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

  const call: CreateCompletion =
    opts.createCompletion ??
    (async ({ model: m, system, user, timeoutMs: t }) => {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: opts.apiKey, timeout: t });
      const res = await client.chat.completions.create({
        model: m,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'judgement', strict: true, schema: JUDGEMENT_SCHEMA },
        },
      });
      const content = res.choices[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        throw new Error('OpenAI returned an empty completion.');
      }
      return content;
    });

  return {
    name: `openai:${model}`,
    async judge(req: JudgementRequest): Promise<Judgement> {
      const raw = await call({ model, system: req.system, user: req.user, timeoutMs });
      return parseJudgement(raw);
    },
  };
}

/** A deterministic client for tests and for the offline demo. */
export function stubLlm(answer: (req: JudgementRequest) => Judgement): LlmClient {
  return {
    name: 'stub',
    judge: async (req) => answer(req),
  };
}
