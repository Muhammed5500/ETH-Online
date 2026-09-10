/**
 * k calculator CLI — Theorem 1 and Theorem 4 of arXiv 2306.04305.
 *
 * This tool is part of the submission, not a scratch script. The README's
 * honesty statement about k says: "the bound asks for k~6 at the signal quality
 * we assume, we run k=3 for a 20-agent pool, and here is the calculator". This
 * is that calculator. Anyone can rerun it and check the claim.
 *
 * Pure computation: no network, no .env, no chain.
 *
 * Run:  pnpm kcalc
 */
import {
  DEFAULT_PARAMS,
  deviationBound,
  flatFeeProbability,
  kMinApprox,
  kMinStrict,
  poolExhaustionProbability,
  signalSpread,
} from '@ethonline/core';

const DELTAS = [0.5, 0.3, 0.2, 0.1] as const;
const ETAS = [0.2, 0.1, 0.05] as const;
const EPSILONS = [0.1, 0.05, 0.01] as const;
const TAUS = [1.0, 0.5, 0.2] as const;

/** Signal quality we assume for the headline claim (PLAN.md section 2.3). */
const REF = { delta: 0.5, eta: 0.1, epsilon: 0.05 } as const;

const N = DEFAULT_PARAMS.minPoolSize;

function pad(s: string, w: number): string {
  return s.padStart(w);
}

function rule(width = 66): string {
  return '='.repeat(width);
}

function heading(title: string): void {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

function table1(): void {
  heading('TABLE 1 — k for approximate truthfulness (Theorem 1, Eq. 3)');
  console.log('  The smallest k that keeps the gain from lying under eps\'.\n');

  for (const eps of EPSILONS) {
    console.log(`  eps' = ${eps.toFixed(2)}`);
    console.log(`  ${pad('', 8)}${ETAS.map((e) => pad(`eta=${e.toFixed(2)}`, 12)).join('')}`);
    for (const d of DELTAS) {
      const cells = ETAS.map((e) => pad(kMinApprox(d, e, eps).toFixed(1), 12)).join('');
      console.log(`  ${pad(`delta=${d.toFixed(2)}`, 8)}${cells}`);
    }
    console.log('');
  }
}

function table2(): void {
  heading('TABLE 2 — k for strict truthfulness (Theorem 4, Eq. 7)');
  console.log(
    '  Approximate truthfulness only bounds what a lie pays. Strict truthfulness\n' +
      '  makes honesty the unique best response, and needs the signal-space\n' +
      '  granularity tau. Finer signal space, more agents.\n',
  );

  console.log(`  ${pad('delta', 7)}${pad('eta', 7)}${TAUS.map((t) => pad(`tau=${t.toFixed(1)}`, 12)).join('')}`);
  for (const d of DELTAS) {
    for (const e of ETAS) {
      const cells = TAUS.map((t) => pad(kMinStrict(d, e, t).toFixed(1), 12)).join('');
      console.log(`  ${pad(d.toFixed(2), 7)}${pad(e.toFixed(2), 7)}${cells}`);
    }
  }
  console.log('');
}

function table3(): void {
  heading(`TABLE 3 — pool sizing at N=${N}, with alpha = 1/(T+k)`);
  console.log(
    '  Not in the paper, which assumes an unbounded pool. With a finite pool a\n' +
      '  larger k lowers alpha, which lengthens the market, which RAISES the odds\n' +
      '  of running out of agents. Lowering k wins on both axes at once: more\n' +
      '  scored agents AND less exhaustion risk.\n' +
      '\n' +
      '  Exhaustion matters because it is the one place the stopping time becomes\n' +
      '  predictable — the last agent in an empty pool knows it is the reference.\n',
  );

  console.log(
    `  ${pad('k', 4)}${pad('T', 4)}${pad('alpha', 9)}${pad('E[length]', 12)}` +
      `${pad('scored', 9)}${pad('P(exhausted)', 15)}${pad('P(flat fee)', 14)}`,
  );

  const options: ReadonlyArray<readonly [number, number]> = [
    [3, 4],
    [3, 5],
    [3, 6],
    [4, 5],
    [5, 5],
    [6, 5],
  ];

  for (const [k, T] of options) {
    const alpha = 1 / (T + k);
    const shipped = k === DEFAULT_PARAMS.k && T === DEFAULT_PARAMS.T;
    console.log(
      `  ${pad(String(k), 4)}${pad(String(T), 4)}${pad(`1/${T + k}`, 9)}` +
        `${pad((1 / alpha).toFixed(1), 12)}${pad(String(T), 9)}` +
        `${pad(`${(poolExhaustionProbability(alpha, N) * 100).toFixed(1)}%`, 15)}` +
        `${pad(`${(flatFeeProbability(alpha, k) * 100).toFixed(1)}%`, 14)}` +
        (shipped ? '   <- shipped' : ''),
    );
  }
  console.log('');
}

function table4(): void {
  heading('TABLE 4 — what k=3 costs us (Theorem 1 deviation bound)');
  console.log(
    `  At delta=${REF.delta}, eta=${REF.eta}: the most a strategic agent can gain\n` +
      '  by misreporting, as a function of how many agents stand behind it.\n',
  );
  console.log(`  ${pad('k', 5)}${pad('|Delta| <=', 14)}`);
  for (const k of [0, 1, 2, 3, 4, 5, 6, 8, 10]) {
    const shipped = k === DEFAULT_PARAMS.k;
    console.log(
      `  ${pad(String(k), 5)}${pad(deviationBound(REF.delta, REF.eta, k).toFixed(4), 14)}` +
        (shipped ? '   <- shipped' : ''),
    );
  }
  console.log('');
}

function verdict(): void {
  const required = kMinApprox(REF.delta, REF.eta, REF.epsilon);
  const requiredInt = Math.ceil(required);
  const shipped = DEFAULT_PARAMS.k;
  const alpha = DEFAULT_PARAMS.alpha;

  console.log(rule());
  console.log('WHAT WE SHIP');
  console.log(rule());
  console.log(
    `  Assumed signal quality:  delta=${REF.delta}, eta=${REF.eta}, ` +
      `spread=${signalSpread(REF.eta).toFixed(3)}`,
  );
  console.log(`  Theorem 1 asks for:      k >= ${required.toFixed(2)}  ->  ${requiredInt} agents`);
  console.log(
    `  Theorem 4 asks for:      k >  ${kMinStrict(REF.delta, REF.eta, 1.0).toFixed(2)}` +
      `  ->  ${Math.ceil(kMinStrict(REF.delta, REF.eta, 1.0))} agents (tau=1.0, strict)`,
  );
  console.log(`  We run:                  k = ${shipped}`);
  console.log('');
  console.log(
    `  Cost of the gap:         |Delta| <= ${deviationBound(REF.delta, REF.eta, shipped).toFixed(3)} ` +
      `instead of ${deviationBound(REF.delta, REF.eta, requiredInt).toFixed(3)}`,
  );
  console.log(
    `  Reason:                  with N=${N} and alpha=1/(T+k), k=${requiredInt} pushes the\n` +
      `                           exhaustion probability to ` +
      `${(poolExhaustionProbability(1 / (DEFAULT_PARAMS.T + requiredInt), N) * 100).toFixed(1)}% ` +
      `(vs ${(poolExhaustionProbability(alpha, N) * 100).toFixed(1)}% at k=${shipped}).`,
  );
  console.log(
    '  Mitigation:              k is a protocol parameter, not a constant. It is\n' +
      '                           raised as the pool grows. There is no strategic\n' +
      '                           agent in the demo, so the bound is not exercised.',
  );
  console.log(rule());
  console.log('');
}

function main(): void {
  console.log('');
  console.log(rule());
  console.log('k CALCULATOR — Srinivasan, Karger, Chen (arXiv 2306.04305)');
  console.log(rule());
  console.log(
    '  k is the number of independent signals the reference agent holds that a\n' +
      '  reporting agent cannot reach. It is what makes lying unprofitable: every\n' +
      '  extra signal multiplies the exploitable gap by (1-delta).\n' +
      '\n' +
      '  delta  Bhattacharyya coefficient bound — how well one signal separates\n' +
      '         the outcome. The paper singles this out as the strongest lever.\n' +
      "  eta    Minimum signal probability — how extreme a signal may be.\n" +
      "  eps'   Target upper bound on what lying can gain (Theorem 1).\n" +
      '  tau    Signal-space granularity (Theorem 4 only).',
  );

  table1();
  table2();
  table3();
  table4();
  verdict();
}

main();
