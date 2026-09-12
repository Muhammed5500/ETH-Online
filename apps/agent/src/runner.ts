/**
 * The agent runner: evidence in, a probability out.
 *
 * WHAT AN AGENT IS FOR. The mechanism scores an agent against the terminal
 * report, so the only thing that matters here is that the number it produces
 * reflects what it actually saw. Everything in this file exists to keep that
 * true: the evidence is bought before the model is asked, the model is never
 * shown the clip, and the raw answer is what gets signed.
 *
 * EVIDENCE FAILURE IS NOT REFUSAL. A slice that errors becomes a caveat in the
 * prompt, not an exception. An agent that declines to answer is timed out and
 * loses its whole bond, which is a far worse outcome than answering from
 * thinner evidence and saying so. What it must never do is treat missing
 * evidence as neutral evidence, so the caveat travels into the prompt.
 *
 * THE THREE BEHAVIOURS ARE CONFIGURATION, NOT CODE PATHS IN THE MECHANISM.
 * PLAN section 10 stages three scenarios and this is where they come from:
 *
 *   honest  ask the model
 *   liar    ask the model, then report the opposite. The market corrects it
 *           and it loses from its bond (scenario 2)
 *   lazy    copy the previous report and buy no evidence at all. When every
 *           agent does this, CE-MSR pays each of them exactly zero, which is
 *           Theorem 7 (scenario 3)
 *
 * `honest` is the default and nothing downstream knows these exist.
 */
import { createHash } from 'node:crypto';
import { beliefFromProbability, type Belief } from '@ethonline/core';
import {
  getSlice,
  type GraphGateway,
  type QuestionContext,
  type SliceEvidence,
} from '@ethonline/graph';
import type { LlmClient } from './llm.js';

export type AgentBehavior = 'honest' | 'liar' | 'lazy';

export interface AgentConfig {
  readonly id: string;
  /** Hedera account. Bonds leave it and payouts arrive in it. */
  readonly accountId: string;
  /** DER private key, used to sign reports. Never leaves the process. */
  readonly privateKey: string;
  readonly publicKey: string;
  readonly ensName?: string;
  /** Which slices this agent reads. Assumption 4 lives here. See STEP 21. */
  readonly sliceIds: readonly string[];
  /** How this agent is told to think. One per agent, never shared. */
  readonly persona: string;
  readonly behavior?: AgentBehavior;
}

/** An earlier report, as the agent is allowed to see it. */
export interface PriorReport {
  readonly position: number;
  readonly agentId: string;
  readonly belief: Belief;
}

export interface ReportInput {
  readonly marketId: string;
  readonly question: string;
  readonly position: number;
  readonly prior: Belief;
  /** Every earlier report. The equilibrium argument assumes the agent sees them. */
  readonly history: readonly PriorReport[];
}

export interface ProducedReport {
  /** RAW and unclipped. The protocol clips. See core/market.ts. */
  readonly probability: number;
  readonly reasoning: string;
  readonly sliceIds: readonly string[];
  readonly evidenceCostUsd: number;
  /** sha256 over the evidence, so a claim can be tied to what produced it. */
  readonly evidenceDigest: string;
  readonly evidence: readonly SliceEvidence[];
  readonly caveats: readonly string[];
}

export interface AgentDeps {
  readonly config: AgentConfig;
  readonly llm: LlmClient;
  /** Omitted for a `lazy` agent, which buys nothing. */
  readonly gateway?: GraphGateway;
  /** Where the slices should look. Supplied per market. */
  readonly targets?: Omit<QuestionContext, 'question'>;
}

/**
 * Canonical bytes for the evidence digest.
 *
 * Only the derived figures go in, not the raw rows: raw responses carry
 * gateway metadata that changes between identical queries, and a digest that
 * changes without the evidence changing proves nothing.
 */
export function evidenceDigest(evidence: readonly SliceEvidence[]): string {
  const canonical = evidence
    .map((e) => ({
      sliceId: e.sliceId,
      signals: [...e.signals]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((s) => [s.key, s.value, s.unit] as const),
      sources: [...e.sources].sort(),
    }))
    .sort((a, b) => a.sliceId.localeCompare(b.sliceId));
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

export class Agent {
  constructor(private readonly deps: AgentDeps) {}

  get id(): string {
    return this.deps.config.id;
  }

  get behavior(): AgentBehavior {
    return this.deps.config.behavior ?? 'honest';
  }

  /**
   * Whether to join a market.
   *
   * Joining is voluntary (PLAN section 3.3), and an agent with no slice that
   * speaks to the question has nothing to add and would only be scored on
   * noise. Kept deliberately simple: the bond decision is not what the paper
   * is about, and a model call here would cost money on every market an agent
   * never enters.
   */
  decideToBond(question: string): boolean {
    if (question.trim().length === 0) return false;
    return this.deps.config.sliceIds.length > 0 || this.behavior === 'lazy';
  }

  /** Buys this agent's slices. A failed slice becomes a caveat, never a throw. */
  async gatherEvidence(question: string): Promise<{
    evidence: SliceEvidence[];
    caveats: string[];
    costUsd: number;
  }> {
    const { gateway, targets, config } = this.deps;
    const evidence: SliceEvidence[] = [];
    const caveats: string[] = [];

    if (!gateway || !targets) {
      return {
        evidence,
        caveats: ['No data source configured; reporting from priors alone.'],
        costUsd: 0,
      };
    }

    const ctx: QuestionContext = { question, ...targets };
    for (const id of config.sliceIds) {
      try {
        const ev = await getSlice(id).fetch(gateway, ctx);
        evidence.push(ev);
        caveats.push(...ev.caveats);
      } catch (e) {
        caveats.push(`Slice "${id}" returned no usable evidence: ${(e as Error).message}`);
      }
    }
    const costUsd = evidence.reduce((s, e) => s + e.queryCostUsd, 0);
    return { evidence, caveats, costUsd };
  }

  /** The whole pipeline: evidence, model, behaviour, raw probability. */
  async produceReport(input: ReportInput): Promise<ProducedReport> {
    const last = input.history[input.history.length - 1];

    // A lazy agent buys nothing and thinks about nothing. That is the point:
    // scenario 3 shows the mechanism paying exactly zero for exactly this.
    if (this.behavior === 'lazy') {
      const copied = last ? last.belief[1] : input.prior[1];
      return {
        probability: copied,
        reasoning: last
          ? `Copying the previous report at position ${last.position}.`
          : 'No previous report; repeating the opening prior.',
        sliceIds: [],
        evidenceCostUsd: 0,
        evidenceDigest: evidenceDigest([]),
        evidence: [],
        caveats: ['This agent bought no evidence.'],
      };
    }

    const { evidence, caveats, costUsd } = await this.gatherEvidence(input.question);
    const judgement = await this.deps.llm.judge({
      question: input.question,
      system: buildSystemPrompt(this.deps.config),
      user: buildUserPrompt(input, evidence, caveats),
    });

    // The lie is applied to the model's answer, not to the prompt. An agent
    // told to lie still has to work out what the truth is first, which is what
    // makes the market's correction of it meaningful.
    const probability =
      this.behavior === 'liar' ? 1 - judgement.probability : judgement.probability;

    return {
      probability,
      reasoning: judgement.reasoning,
      sliceIds: evidence.map((e) => e.sliceId),
      evidenceCostUsd: costUsd,
      evidenceDigest: evidenceDigest(evidence),
      evidence,
      caveats,
    };
  }
}

export function buildSystemPrompt(config: AgentConfig): string {
  return [
    `You are ${config.id}, an analyst in a prediction market.`,
    '',
    config.persona,
    '',
    'HOW YOU ARE PAID. The market closes at a random point and the LAST report',
    'becomes the reference. You are scored on how far you moved the price',
    'towards that reference. So report what you expect a well-informed later',
    'analyst to conclude, which, if you reason honestly from your evidence, is',
    'your own honest belief.',
    '',
    'RULES.',
    '- Report a probability in [0, 1]. Never 0 and never 1.',
    '- Do not round or clip. The protocol clips; your raw number is recorded.',
    '- Your evidence is one view of the question, not all of it. Other analysts',
    '  see different views. Weigh the earlier reports accordingly.',
    '- Cite the derived figures you actually used.',
  ].join('\n');
}

export function buildUserPrompt(
  input: ReportInput,
  evidence: readonly SliceEvidence[],
  caveats: readonly string[],
): string {
  const parts: string[] = [`QUESTION: ${input.question}`, ''];

  parts.push(`Opening prior: P(yes) = ${input.prior[1]}`);
  parts.push(`You are reporting at position ${input.position}.`, '');

  if (input.history.length === 0) {
    parts.push('No earlier reports. You are first.');
  } else {
    parts.push('EARLIER REPORTS, in order:');
    for (const r of input.history) {
      parts.push(`  ${r.position}. ${r.agentId} reported P(yes) = ${r.belief[1]}`);
    }
  }
  parts.push('');

  if (evidence.length === 0) {
    parts.push('YOUR EVIDENCE: none available.');
  } else {
    parts.push('YOUR EVIDENCE:');
    for (const e of evidence) {
      parts.push('', e.summary);
    }
  }

  if (caveats.length > 0) {
    parts.push('', 'LIMITS ON YOUR EVIDENCE:');
    for (const c of caveats) parts.push(`  - ${c}`);
  }

  parts.push('', 'Report your probability that the answer is YES.');
  return parts.join('\n');
}

/** Belief form, for callers that want it. The protocol still clips. */
export function toBelief(probability: number): Belief {
  return beliefFromProbability(probability);
}
