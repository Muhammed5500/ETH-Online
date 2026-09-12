/**
 * Tests for the model boundary.
 *
 * The cases worth reading are the rejections. A model that answers `"0.7"` or
 * `72` instead of `0.7` is not a hypothetical — both are common — and both
 * would coerce into a plausible-looking number that goes straight into a
 * scored report. There is no later stage that can tell a coerced 0.99 from
 * genuine conviction, so the parse has to refuse them here.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OPENAI_MODEL,
  JUDGEMENT_SCHEMA,
  openAiLlm,
  parseJudgement,
  stubLlm,
  type CreateCompletion,
} from '../src/llm.js';

describe('parseJudgement', () => {
  it('reads a well-formed answer', () => {
    const j = parseJudgement('{"probability": 0.73, "reasoning": "Flows are concentrated."}');
    expect(j.probability).toBe(0.73);
    expect(j.reasoning).toBe('Flows are concentrated.');
  });

  it('accepts the boundaries, because the protocol clips, not the agent', () => {
    // An agent reporting 0 is reporting an honest certainty it is not allowed
    // to express; clipping it is the protocol's job and has to stay visible in
    // the audit trail as a clip. Rejecting it here would hide that.
    expect(parseJudgement('{"probability": 0, "reasoning": ""}').probability).toBe(0);
    expect(parseJudgement('{"probability": 1, "reasoning": ""}').probability).toBe(1);
  });

  it('REFUSES a stringified number rather than coercing it', () => {
    expect(() => parseJudgement('{"probability": "0.7", "reasoning": "x"}')).toThrow(
      /must be a finite number/,
    );
  });

  it('REFUSES a 0-100 scale, which would otherwise clip to near-certainty', () => {
    expect(() => parseJudgement('{"probability": 72, "reasoning": "x"}')).toThrow(/\[0, 1\]/);
  });

  it('refuses NaN and negatives', () => {
    expect(() => parseJudgement('{"probability": null, "reasoning": "x"}')).toThrow();
    expect(() => parseJudgement('{"probability": -0.1, "reasoning": "x"}')).toThrow(/\[0, 1\]/);
  });

  it('refuses anything that is not JSON, with the text attached', () => {
    expect(() => parseJudgement('I think about 70%.')).toThrow(/did not return JSON/);
  });

  it('refuses a JSON scalar', () => {
    expect(() => parseJudgement('0.7')).toThrow(/expected an object/);
  });

  it('tolerates missing reasoning, since nothing is scored on it', () => {
    expect(parseJudgement('{"probability": 0.4}').reasoning).toBe('');
  });
});

describe('the schema handed to the model', () => {
  it('demands both fields and forbids extras', () => {
    expect(JUDGEMENT_SCHEMA.required).toEqual(['probability', 'reasoning']);
    expect(JUDGEMENT_SCHEMA.additionalProperties).toBe(false);
  });

  it('tells the model not to round, because rounding hides the clip', () => {
    expect(JUDGEMENT_SCHEMA.properties.probability.description).toMatch(/not round/i);
  });
});

describe('openAiLlm', () => {
  it('passes the prompt through and parses what comes back', async () => {
    const create = vi.fn<CreateCompletion>(async () =>
      '{"probability": 0.61, "reasoning": "Turnover is high relative to fees."}',
    );
    const llm = openAiLlm({ apiKey: 'test-key', createCompletion: create });

    const j = await llm.judge({ question: 'q?', system: 'sys', user: 'usr' });

    expect(j.probability).toBe(0.61);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0]).toMatchObject({
      model: DEFAULT_OPENAI_MODEL,
      system: 'sys',
      user: 'usr',
    });
  });

  it('names the model it used, so a report can say where it came from', () => {
    expect(openAiLlm({ apiKey: 'k', model: 'gpt-4o' }).name).toBe('openai:gpt-4o');
  });

  it('lets a bad answer fail loudly rather than reporting a guess', async () => {
    const llm = openAiLlm({
      apiKey: 'k',
      createCompletion: async () => 'sorry, I cannot say',
    });
    await expect(llm.judge({ question: 'q', system: 's', user: 'u' })).rejects.toThrow(
      /did not return JSON/,
    );
  });
});

describe('stubLlm', () => {
  it('answers from the injected function and never touches the network', async () => {
    const llm = stubLlm((req) => ({
      probability: req.user.includes('wash') ? 0.9 : 0.2,
      reasoning: 'stub',
    }));
    expect((await llm.judge({ question: 'q', system: 's', user: 'wash trading' })).probability).toBe(0.9);
    expect((await llm.judge({ question: 'q', system: 's', user: 'organic' })).probability).toBe(0.2);
  });
});
