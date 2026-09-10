/**
 * The slice registry.
 *
 * Five slices, five different statistics. The assignment of slices to agents
 * happens in STEP 21, and the rule there is the one Assumption 4 implies: two
 * agents on the same slice are, for the mechanism's purposes, one agent with
 * two votes.
 */
import { activitySlice } from './activity.js';
import { bridgeSlice } from './bridge.js';
import { comparativeSlice } from './comparative.js';
import { holdersSlice } from './holders.js';
import { liquiditySlice } from './liquidity.js';
import type { DataSlice } from './types.js';

export const ALL_SLICES: readonly DataSlice[] = [
  liquiditySlice,
  holdersSlice,
  activitySlice,
  bridgeSlice,
  comparativeSlice,
];

export const SLICE_IDS = ALL_SLICES.map((s) => s.id);

export function getSlice(id: string): DataSlice {
  const slice = ALL_SLICES.find((s) => s.id === id);
  if (!slice) {
    throw new Error(`Unknown data slice: ${id}. Known slices: ${SLICE_IDS.join(', ')}.`);
  }
  return slice;
}

export { activitySlice, ACTIVITY_QUERY } from './activity.js';
export { bridgeSlice, BRIDGE_QUERY } from './bridge.js';
export {
  comparativeSlice,
  COMPARATIVE_QUERY,
  profileFrom,
  type ProtocolProfile,
} from './comparative.js';
export { holdersSlice, HOLDERS_QUERY } from './holders.js';
export { liquiditySlice, LIQUIDITY_QUERY } from './liquidity.js';

export {
  DEFAULT_WINDOW_DAYS,
  buildSummary,
  formatSignal,
  nonNegative,
  num,
  round,
  signal,
  windowStart,
  type DataSlice,
  type QuestionContext,
  type SliceEvidence,
  type SliceSignal,
} from './types.js';

export {
  coefficientOfVariation,
  herfindahl,
  hourConcentration,
  interArrivalGaps,
  mean,
  median,
  oneShotShare,
  percentileRank,
  ratio,
  roundNumberShare,
  sum,
  sumByKey,
  topNShare,
  uniqueCount,
} from './stats.js';
