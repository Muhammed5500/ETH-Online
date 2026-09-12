# A self-resolving prediction market for questions no oracle can settle

Some questions have on-chain evidence and no verifiable answer. "Is this
protocol's TVL growth organic or wash-farmed?" has a right answer, but nothing
will ever report it. A normal prediction market cannot exist here, because
there is nothing to resolve against.

This one resolves against itself. AI agents are drawn one at a time, each sees
every earlier report and its own slice of evidence, and each reports a
probability. After every report the market closes with probability `alpha`. The
last agent to report becomes the **reference**, its report is the closing
price, and everyone before it is scored against that. The last `k` agents take
a flat fee, because there is no longer enough information behind them to score
against.

Nobody outside the market is consulted. There is no oracle, and there is no
appeal.

**Theory:** Srinivasan, Karger, Chen, *Self-Resolving Prediction Markets for
Unverifiable Outcomes*, [arXiv 2306.04305](https://arxiv.org/abs/2306.04305).
The paper is in `docs/paper/`; the design decisions taken from it, and the ones
rejected, are in [PLAN.md](./PLAN.md).

## What actually runs

| Piece | Status |
| --- | --- |
| Mechanism: scoring, stopping, settlement, invariants | complete, 750 unit tests |
| Hedera: deposits, bonds, HCS ledger, randomness, settlement | verified end to end on **testnet** |
| x402 payment gate on Hedera (Blocky402) | live on the paid routes |
| The Graph: five data slices over Messari standardized subgraphs | live data, real queries, real cost |
| 20 agents buying evidence and reporting over HTTP | verified on **Hedera testnet**, real x402 payments |
| `POST /resolve`, the x402-gated resolution service | live |
| Frontend: market list, live chart, settlement view | built, served by the API itself, paid from a browser wallet |
| Runner: bonding closes, rounds run, settlement executes, unfilled markets refund | in the API process, verified on **testnet** |
| Agents paying their own bonds over x402 | in the fleet, verified on **testnet** |
| Agent directory: slice subsets and each agent's record, counted from the markets | built |
| ENS v2 agent identity | **not in this version**, see Limits |

## The whole thing, running

Two processes. The API serves the pages, takes the money, drives the rounds and
settles; the fleet is twenty agents that watch for markets and pay their own way
in.

```bash
pnpm --filter @ethonline/web build   # once, so the API has pages to serve
pnpm api                             # http://127.0.0.1:4020
pnpm agents                          # another terminal
```

Open the page, connect a wallet, ask a question. The deposit is paid over x402,
twenty agents bond themselves, the rounds run against live Graph data and a
model, and the settlement pays everyone from the treasury. One run on testnet,
[topic 0.0.10504951](https://hashscan.io/testnet/topic/0.0.10504951): three
reports, 0.184 to 0.188 to 0.379, and the treasury closed at
`in 2099314719 = out 2099314719`.

## Quick start

```bash
pnpm install
cp .env.example .env      # fill in the keys listed below
pnpm test                 # 750 tests, no network, a few seconds
```

Required for a full run:

| Variable | For |
| --- | --- |
| `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY` | testnet account that pays fees |
| `HEDERA_TREASURY_ID` / `HEDERA_TREASURY_KEY` | receives deposits and bonds, pays settlements |
| `GRAPH_API_KEY` | The Graph Studio key (free), or use `GRAPH_GATEWAY_MODE=x402` |
| `GRAPH_SUBJECT_SUBGRAPH`, `GRAPH_PEER_SUBGRAPHS`, `GRAPH_BRIDGE_SUBGRAPH` | Messari standardized deployment ids |
| `OPENAI_API_KEY` | agent reasoning |

Then create the pool once:

```bash
pnpm setup:hedera         # treasury + 20 agent accounts, idempotent
```

## Prove it yourself

Four commands, each one a gate rather than a demo.

```bash
pnpm check:hedera         # keys, balance, HCS write, running hash -> [0,1)
pnpm check:graph --slices # all five slices against live subgraphs, with cost
pnpm scenarios            # the four mechanism scenarios
```

```bash
pnpm agents               # 20 agent processes, each with its own key and budget
pnpm check:resolve        # open, bond, run over HTTP, settle, then sell the answer
```

Those two use an in-memory ledger, so they can be repeated for nothing. To put
the same fleet on real Hedera testnet — the asker and all twenty bonds paying
with x402, every report written to HCS, the settlement moving real HBAR:

```bash
pnpm agents                                # one terminal
pnpm check:orchestrator --external-agents  # another
```

`check:resolve`, in memory, on this machine:

```
[PASS] 20 agents registered, every agent published an endpoint
[PASS] Answers 202, not a guess
[PASS] Asking again points at the same market, never a second one
[PASS] 5 reports in 23.1s, 0 timed out
[PASS] 5 reports carried slice + cost metadata — evidence spend $0.1900
[PASS] Settled in 3 chunks, books balance: in 2099314719 = out 2099314719
[PASS] The price sold IS the terminal report — sold 0.3, terminal 0.3
```

And the same fleet on Hedera testnet, market
[0.0.10499955](https://hashscan.io/testnet/topic/0.0.10499955):

```
[PASS] Market opened and paid for       mkt-2026-09-12-001 on 0.0.10499955
[PASS] Every bond is in the pool        20/20, each paid with x402
  # 1 agent-05 p=0.816   # 2 agent-19 p=0.308   # 3 agent-02 p=0.428
  # 4 agent-17 p=0.366   # 5 agent-14 p=0.717   # 6 agent-08 p=0.375
  # 7 agent-10 p=0.309 CLOSE
[PASS] Market closed                    7 reports, stopping-rule
[PASS] The reference is the terminal agent
[PASS] The plan balances exactly        2099314719 tinybar in and out
[PASS] All 3 transfer transactions succeeded
[PASS] The treasury is square           delta 0.00000000 HBAR
[PASS] Every agent that answered was paid    20 agents, 0 slashed
[PASS] Ledger holds all 13 events
[PASS] Ends with market-close, settlement, then one message per transfer chunk
[PASS] Consensus order is intact
ORCHESTRATOR OK — a full market ran and the books closed.
```

Seven reports, four of them scored, and the price moved from 0.816 to 0.309 as
agents on different evidence disagreed and converged. Every report is on the
topic above and can be read back from a public mirror node.

And the scenario the mechanism is really about:

```
3. EVERY AGENT COPIES THE LAST ONE — THEOREM 7

    pos  agent      kind       payout
      1  agent-01   scored       0.000000000000
      2  agent-05   scored       0.000000000000
      3  agent-15   scored       0.000000000000
      4  agent-11   scored       0.000000000000
      5  agent-17   scored       0.000000000000

    scored agents: 5, largest |payout| = 0.000e+0
```

There is no way to be paid for copying. That is Theorem 7 of the paper, running
live rather than quoted.

## Architecture

Full diagrams and the money flow: [docs/architecture.md](./docs/architecture.md).

The short version. One round is: draw an agent from the running hash of the last
HCS message, ask it over HTTP with a deadline, write its report to HCS, and roll
the stopping dice from the **new** running hash that write produced. The roll has
to come last, because that hash did not exist until the network reached
consensus, which is the only reason nobody could know where the market would
stop.

## Payment flow

Three routes cost money, and each is money entering the mechanism, so the
payment *is* the action and there is nothing to authenticate separately.

| Route | Price | Paid by |
| --- | --- | --- |
| `POST /market` | `b·H_max(prior) + k·R`, computed, plus the protocol fee | the asker |
| `POST /market/:id/bond` | that market's bond | each agent |
| `POST /resolve` | flat per-call fee | anyone buying an answer |

Prices are computed by the same functions the handlers use, so the amount quoted
in the 402 and the amount the handler assumes was paid cannot drift apart.

**Where a fee can go, and where it cannot.** The honesty guarantee is a
statement about the scoring payments: an agent's expected payoff is exactly
`S_CEM`, which is why reporting its belief is its best move. A fee taken out of
agent payouts would change that function and sell the only claim this project
has. So the protocol fee is charged at the door instead — the asker pays
`deposit + fee`, the market is funded with the deposit, and the fee never
enters the pot settlement pays out of. It is quoted in the 402 before anything
is paid, and `PROTOCOL_FEE_TINYBAR` is zero unless a deployment sets it.

Reports are free, so payment cannot prove authorship. An agent signs its report
with the same Hedera key it bonded and gets paid with, over the **raw**
probability, before clipping. Verifying against the clipped value fails, which
is what keeps the protocol's own clip auditable.

Everything readable is open, and so is agent registration. There is no allowlist
anywhere in the code.

## The resolution service

`POST /resolve` sells one answer per call.

| Situation | Answer |
| --- | --- |
| the question was already answered | `200` with the price, the breakdown, and the topic to check it against |
| a market for it is already running | `202` pointing at that market |
| nothing exists yet | `202`, a market is opened |

It never blocks and it never guesses. Running the mechanism takes twenty bonds
and a sequence of consensus rounds, and no HTTP client waits that long; returning
a model's opinion in the meantime would sell an answer the mechanism never
produced.

It also never opens a second market for a question already in flight. Two markets
on one question split the agent pool and produce two prices, each built from half
the information, which is the design the paper rejects.

## The Graph is load-bearing

Every agent buys its own evidence, and that evidence decides who gets paid.

Each agent holds a **distinct subset** of five slices. This is not variety for
its own sake: the paper's Assumption 4 requires agent signals to be conditionally
independent given the outcome, and twenty agents reading the same rows would be
one agent with twenty votes. Two tests enforce it, one across slices and one
across the pool.

Queries were written against Messari's real downloaded schema, not from memory,
which caught two things a guess would not have: `Account` carries no balance, so
holder concentration is derived from deposit flow and reported with that caveat;
and the standard has no gas field, so the activity slice measures timing and
repetition instead.

Cost is tracked per query and travels with the answer, so a buyer is told what
the evidence behind their price cost.

## Repo layout

```
packages/core     the mechanism: scoring, market, settlement. Pure TypeScript.
packages/hedera   HCS ledger, randomness, accounts, x402
packages/graph    Gateway client and the five data slices
packages/ens      not implemented in this version
apps/api          routes, orchestrator, settlement execution
apps/agent        agent runner, LLM boundary, agent HTTP server, the pool
apps/web          frontend
scripts           the gates listed above
```

## Commands

| Command | Does |
| --- | --- |
| `pnpm test` | 750 unit tests, no network |
| `pnpm test:integration` | real testnet, slow, separate on purpose |
| `pnpm build` | typecheck everything |
| `pnpm demo` | the whole API on an in-memory ledger, markets pre-seeded. `POST /market` is gated by the real x402 gate whenever a treasury is configured, so asking a question costs the deposit; `--free` turns that off |
| `pnpm agents` | the 20-agent fleet, each paying its own bonds (`--offline` for a stub model, `--no-bond` to only listen) |
| `pnpm scenarios` | the four scenarios (`--real` for live model and evidence) |
| `pnpm kcalc` | the `k` calculator from Theorems 1 and 4 |

## Limits, stated plainly

**ENS is not in this version.** It was planned as agent identity and reputation.
It is not built, not stubbed and not claimed.

**Agents are ours.** Registration is open in the code and the asking side is open
to anyone, but this deployment seeds the pool with twenty agents we run. No part
of the protocol assumes that, and [docs/join.md](./docs/join.md) is the whole
procedure for bringing your own.

**An agent has to be reachable.** Reports are pushed to the address an agent
registers, so an agent behind NAT needs a tunnel — one `cloudflared` command,
no account. An agent that polled for work instead would need no address at all;
that is the next thing to build and it is not built.

**`k = 3` is below what the theory wants.** Theorem 1 asks for roughly 6 at the
signal quality we assume. We run 3 so a 20-agent pool is workable, and `k` is a
protocol parameter rather than a constant. `pnpm kcalc` computes the requirement.

**A finite pool leaks in one place.** Unpredictable stopping holds everywhere
except the last position: if the pool runs out, the final agent knows it is the
reference. At `N = 20, alpha = 1/8` that happens 7.9% of the time, and the market
records `pool-exhausted` when it does.

**Assumption 4 is approached, not satisfied.** Distinct slice subsets still share
underlying rows.

**Nothing proves an agent tried.** The paper flags effort as future work and so do
we.

**The model is OpenAI, not Claude.** The plan specified `claude-sonnet-5`; no
Anthropic key was available, so `gpt-4o-mini` is used behind a one-function
interface. Nothing in the mechanism depends on which model produced a number.

**A paid handler runs before its payment settles, so its effect is
conditional.** `@x402/express` orders a paid route as verify, handler, settle:
if settlement fails the library answers 402 and nothing undoes what the handler
already wrote. A live run on 2026-09-12 recorded twenty bonds against eighteen
payments and the treasury closed 2 HBAR down, which the run's own treasury
invariant caught. Effects on the three paid routes are now registered with an
undo that runs before the 402 leaves the server. What cannot be undone is HCS: a
market whose deposit never settled leaves a topic holding one `market-open`
message and nothing after it.

**An unreachable x402 facilitator returns a bare 500.** `@x402/express` writes
that response itself, before any wrapper or error handler can see it. Mitigated
with a startup warm-up, a configurable timeout and client-side retry, but not
fixable from the application layer.

**Settlement transfers are chunked and not atomic across chunks.** Hedera caps
how many accounts one transfer may touch. A settlement that stops partway is
recorded, resumable, and never pays a chunk twice.

**The market store is in memory, and a restart empties it.** Every report,
close and settlement is on its HCS topic and can be recomputed by anyone, but
nothing reads them back: restarting the API leaves the pages showing no markets
while the markets themselves are still on chain and still verifiable. Reports
that arrive for a market the server has forgotten are refused, so a restart
mid-market strands that market's deposit and bonds in the treasury until
somebody refunds them by hand. Rehydrating a market from its topic is the fix
and is not written.

**The demo server takes the deposit but does not give it back.** `pnpm demo`
runs the production x402 gate over an in-memory ledger, so a market really is
paid for and the HBAR really reaches the treasury. Settlement then records the
transfers instead of sending them, because the twenty agents it pays are
fabricated accounts. The round trip is `pnpm api` with `pnpm agents`.

**The resolution service has not been run against the chain.** `POST /resolve`
is proven end to end against the in-memory ledger, and the on-chain markets
were opened through `POST /market` instead. The mechanism, the payments and the
settlement underneath are the same code either way, but the service route
itself has not carried a real market.

## Documents

| File | Contents |
| --- | --- |
| [docs/join.md](./docs/join.md) | how to run your own agent against a deployment of this |
| [docs/ens-role-schema.md](./docs/ens-role-schema.md) | which ENS records an agent may write about itself, and which it may not |
| [PLAN.md](./PLAN.md) | decisions, rationale, rejected designs (Turkish) |
| [ROADMAP.md](./ROADMAP.md) | the 34-step build plan with a test gate per step (Turkish) |
| [docs/step-log.md](./docs/step-log.md) | what was built, what broke, and why (Turkish) |
| [docs/architecture.md](./docs/architecture.md) | diagrams, round ordering, money flow |
