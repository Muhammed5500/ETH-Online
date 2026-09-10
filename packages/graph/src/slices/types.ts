/**
 * Data slices — what makes twenty agents genuinely different.
 *
 * THIS IS NOT COSMETIC DIVERSITY. The paper's Assumption 4 requires agent
 * signals to be conditionally independent given the outcome, and its own
 * conclusion flags relaxing that as future work. Twenty agents querying the
 * same data and asking the same model would violate it outright: the
 * Bhattacharyya coefficient `delta` would go to 1, and the `k` that Theorem 1
 * demands would go to infinity with it. The mechanism would still run and its
 * honesty guarantee would mean nothing.
 *
 * So each slice looks at a different part of the chain and, more importantly,
 * computes a different STATISTIC from it. Two slices reading the same rows and
 * reporting the same ratio would be one slice wearing two hats.
 *
 * We do not claim Assumption 4 is satisfied. We claim the slices are built to
 * approach it, and PLAN section 14 says exactly that out loud.
 *
 * WHAT A SLICE MUST NOT DO. It must not answer the question. A slice returns
 * evidence and derived figures; the agent's model reads that and reports a
 * probability. Putting a verdict in the slice would make twenty agents agree
 * by construction, which is the failure this whole file exists to prevent.
 */
import type { GraphGateway } from '../gateway.js';

/** What the market is asking about, and where to look. */
export interface QuestionContext {
  readonly question: string;
  /**
   * The subgraph the question is about. A Messari standardized deployment, so
   * one query shape works across protocols.
   */
  readonly subgraphId: string;
  /** Peers for the comparative slice. The standard is what makes this possible. */
  readonly peerSubgraphIds?: readonly string[];
  /** A Messari bridge-schema subgraph, when the question touches cross-chain flow. */
  readonly bridgeSubgraphId?: string;
  /** How far back to look. Default 30. */
  readonly windowDays?: number;
  /** Injected so a slice's window is reproducible in tests. */
  readonly now?: number;
}

/** One derived number, with the words needed to read it. */
export interface SliceSignal {
  readonly key: string;
  readonly value: number | null;
  /** `usd`, `ratio`, `share`, `count`, `days`, or a unit of its own. */
  readonly unit: string;
  /** What it means, in a sentence a model can use. */
  readonly note: string;
}

export interface SliceEvidence {
  readonly sliceId: string;
  /** Human-readable, handed straight to the model. */
  readonly summary: string;
  /** The derived figures. This is the part that differs between slices. */
  readonly signals: readonly SliceSignal[];
  /** What came back from the gateway, kept so a claim can be traced to a row. */
  readonly raw: unknown;
  readonly queryCostUsd: number;
  /** Subgraph ids this evidence came from. */
  readonly sources: readonly string[];
  /** Queries run. More than one for the comparative slice. */
  readonly queryCount: number;
  /**
   * Something was missing or thin.
   *
   * Reported rather than thrown: a subgraph with two weeks of history is still
   * evidence, and an agent that refuses to answer loses its whole bond. What
   * it must not do is treat thin evidence as strong, so the caveat travels
   * with the summary into the prompt.
   */
  readonly caveats: readonly string[];
}

export interface DataSlice {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Which Messari schema this slice speaks. */
  readonly schema: 'dex-amm' | 'bridge';
  fetch(gateway: GraphGateway, ctx: QuestionContext): Promise<SliceEvidence>;
}

export const DEFAULT_WINDOW_DAYS = 30;

export function windowStart(ctx: QuestionContext): number {
  const now = ctx.now ?? Date.now();
  const days = ctx.windowDays ?? DEFAULT_WINDOW_DAYS;
  return Math.floor(now / 1000) - days * 86_400;
}

/**
 * Parses a GraphQL numeric.
 *
 * `BigDecimal` and `BigInt` both arrive as strings, and a missing value
 * arrives as `null`. Returning `null` rather than 0 keeps "no data" distinct
 * from "zero", which matters: a protocol with no volume and a protocol whose
 * subgraph does not track volume are very different answers.
 */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** `num` with a floor of 0, for places where a negative would be nonsense. */
export function nonNegative(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.max(0, n);
}

export function signal(
  key: string,
  value: number | null,
  unit: string,
  note: string,
): SliceSignal {
  return { key, value: value === null ? null : round(value), unit, note };
}

export function round(x: number, places = 6): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}

/** Formats a signal for the summary text a model reads. */
export function formatSignal(s: SliceSignal): string {
  if (s.value === null) return `  ${s.key}: no data — ${s.note}`;
  const value =
    s.unit === 'share'
      ? `${round(s.value * 100, 2)}%`
      : s.unit === 'usd'
        ? `$${s.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
        : `${s.value}`;
  return `  ${s.key}: ${value} — ${s.note}`;
}

/** Builds the block of text a slice hands to the model. */
export function buildSummary(
  title: string,
  lines: readonly string[],
  signals: readonly SliceSignal[],
  caveats: readonly string[],
): string {
  const parts = [title, ...lines, '', 'Derived figures:', ...signals.map(formatSignal)];
  if (caveats.length > 0) {
    parts.push('', 'Caveats:', ...caveats.map((c) => `  - ${c}`));
  }
  return parts.join('\n');
}
