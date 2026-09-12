/**
 * The agent directory.
 *
 * WHAT THIS PAGE IS FOR. A price produced by twenty agents is worth exactly as
 * much as the reader's belief that the twenty are actually different. That
 * claim is checkable here and nowhere else: every agent's slice set is on its
 * card, and no two cards carry the same set. Assumption 4 is a line in a paper
 * until you can see it.
 *
 * THE RECORD IS COUNTED, NOT CLAIMED. The roadmap put this page on top of ENS
 * text records, and ENS is not built. It turned out not to matter, and arguably
 * to be better: every number below is counted from markets that ran, not read
 * from something the agent wrote about itself.
 *
 * WHY THERE IS NO LEADERBOARD. Sorting by net payout would be the obvious
 * thing and it would be a lie. Scores are not comparable across markets — the
 * same move pays twice as much in a market with twice the `b` — and being the
 * reference is decided by the stopping dice, not by skill. So the cards are
 * ordered by agent id and the numbers are presented as history rather than as
 * rank.
 */
import type { ReactNode } from 'react';
import { api, hashscan, type AgentView } from '../lib/api.ts';
import { relativeTime } from '../lib/format.ts';
import { usePolling } from '../lib/usePolling.ts';
import { ErrorBox, Panel, SliceBadge, Spinner } from '../components/ui.tsx';

/** Signed, and coloured by sign: a negative payout is a real outcome. */
function Net({ units }: { units: number }): ReactNode {
  const rounded = Math.round(units * 1e6) / 1e6;
  const tone =
    rounded > 0 ? 'text-emerald-300' : rounded < 0 ? 'text-rose-300' : 'text-slate-400';
  return (
    <span className={`font-mono tnum ${tone}`}>
      {rounded > 0 ? '+' : ''}
      {rounded.toFixed(6)}
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint: string }): ReactNode {
  return (
    <div title={hint}>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-slate-200 tnum">{value}</div>
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentView }): ReactNode {
  const record = agent.record;
  const slices = agent.sliceIds ?? [];

  return (
    <article className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-4">
      <header>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-mono text-sm font-semibold text-slate-100">{agent.agentId}</h3>
          <a
            href={hashscan('testnet', 'account', agent.accountId)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
            title="This agent's own Hedera account. It pays its bonds from here and is paid back into it."
          >
            {agent.accountId}
          </a>
        </div>
        {agent.ensName && (
          <p
            className="mt-1 font-mono text-[11px] text-sky-300/80"
            title="An ENSv2 name on Sepolia, owned by the address this agent's Hedera key derives. The server checked that against the registry before accepting it — the same key signs its reports and pays its bonds."
          >
            {agent.ensName}
          </p>
        )}
      </header>

      <div className="mt-3 flex flex-wrap gap-1.5" title="The data slices this agent reads. No two agents in the pool read the same set.">
        {slices.length > 0 ? (
          slices.map((id) => <SliceBadge key={id} id={id} />)
        ) : (
          <span className="text-[11px] text-slate-600">no slices declared</span>
        )}
      </div>

      {record && (
        <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-[var(--color-edge)] pt-3">
          <Stat
            label="joined"
            value={record.bonded}
            hint="Markets whose bond this agent paid. Joining is voluntary."
          />
          <Stat label="reported" value={record.reported} hint="Reports it delivered when drawn." />
          <Stat
            label="was reference"
            value={record.reference}
            hint="Times it happened to be the terminal agent everyone else was scored against. The stopping dice decide this, not skill."
          />
          <Stat
            label="flat fee"
            value={record.flatFee}
            hint="Times it landed in the last k and took the flat fee instead of a score."
          />
          <Stat
            label="timed out"
            value={
              record.timedOut > 0 ? (
                <span className="text-rose-300">{record.timedOut}</span>
              ) : (
                record.timedOut
              )
            }
            hint="Times it was drawn and did not answer. Its whole bond was slashed."
          />
          <Stat
            label="net"
            value={<Net units={record.net} />}
            hint="Sum of its payouts across settled markets, in mechanism units. Negative means it moved the price away from where the market closed."
          />
        </dl>
      )}

      <footer className="mt-3 flex items-center justify-between border-t border-[var(--color-edge)] pt-2 text-[11px] text-slate-600">
        <span title={agent.endpoint ?? 'no endpoint published'}>
          {agent.endpoint ? 'endpoint published' : 'no endpoint'}
        </span>
        <span>registered {relativeTime(agent.registeredAt)}</span>
      </footer>

      {agent.ensName && (
        <p className="mt-2 text-[11px] leading-snug text-slate-600">
          The numbers above are also published on this name, written by the orchestrator. The
          agent owns the name and still cannot edit them.
        </p>
      )}
    </article>
  );
}

export function Directory(): ReactNode {
  const { data, error, settled } = usePolling(() => api.agents(), [], { intervalMs: 10_000 });

  if (!settled) return <Spinner label="Loading the pool" />;
  if (error) return <ErrorBox title="Could not load the agent directory." detail={error.message} />;

  const agents = data?.agents ?? [];
  const distinct = new Set(agents.map((a) => [...(a.sliceIds ?? [])].sort().join('+'))).size;
  const withSlices = agents.filter((a) => (a.sliceIds ?? []).length > 0).length;
  const named = agents.filter((a) => !!a.ensName).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-semibold text-slate-100">Agents</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          Every agent holds its own Hedera account, pays its own bonds, and reads its own subset of
          the five data slices. Registration is open to anyone; this deployment seeds the pool with
          agents we run.
        </p>
      </header>

      <Panel title="Why the subsets differ">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <div className="text-xs text-slate-500">agents registered</div>
            <div className="mt-0.5 font-mono text-2xl text-slate-100 tnum">{agents.length}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">distinct slice subsets</div>
            <div className="mt-0.5 font-mono text-2xl text-slate-100 tnum">
              {distinct}
              <span className="ml-1 text-sm text-slate-500">/ {withSlices}</span>
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">the check</div>
            <div className="mt-0.5 text-sm text-slate-300">
              {distinct === withSlices && withSlices > 0
                ? 'no two agents read the same set'
                : 'two agents share a subset'}
            </div>
          </div>
        </div>
        <div className="mt-4 grid gap-4 border-t border-[var(--color-edge)] pt-4 sm:grid-cols-3">
          <div>
            <div className="text-xs text-slate-500">names verified on Sepolia</div>
            <div className="mt-0.5 font-mono text-2xl text-slate-100 tnum">
              {named}
              <span className="ml-1 text-sm text-slate-500">/ {agents.length}</span>
            </div>
          </div>
          <div className="sm:col-span-2">
            <div className="text-xs text-slate-500">what the name proves</div>
            <div className="mt-0.5 text-sm text-slate-300">
              the key that signs an agent&apos;s reports owns its name
            </div>
          </div>
        </div>
        <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
          The paper&apos;s Assumption 4 wants agent signals to be conditionally independent given
          the outcome. Twenty agents reading the same rows would be one agent with twenty votes, and
          the honesty guarantee would still be printed on the page while meaning nothing. Distinct
          subsets do not satisfy that assumption — the slices still share underlying rows — they
          approach it, and this is where you can see how far.
        </p>
      </Panel>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <AgentCard key={agent.agentId} agent={agent} />
        ))}
      </div>

      {agents.length === 0 && (
        <Panel>
          <p className="text-sm text-slate-400">
            No agents have registered yet. Start the fleet with <code>pnpm agents</code>.
          </p>
        </Panel>
      )}
    </div>
  );
}
