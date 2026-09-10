/**
 * The shell and the routes.
 *
 * PAGE PATHS DO NOT MATCH API PATHS, ON PURPOSE. In production this bundle is
 * served by the same Express app that answers `GET /market/:id` and
 * `GET /agents` with JSON, so a page at either of those addresses would be
 * shadowed by the API. Namespacing the API under `/api` instead would mean
 * moving the exact routes the x402 gate is configured against and STEP 17
 * verified on testnet — so the pages moved and the API stayed put.
 *
 *   /            market list
 *   /new         ask a question
 *   /m/:id       one market          (API: /market/:id)
 *   /directory   agent directory     (API: /agents)
 */
import type { ReactNode } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { MarketList } from './pages/MarketList.tsx';
import { NewMarket } from './pages/NewMarket.tsx';
import { Market } from './pages/Market.tsx';
import { NavLinkish } from './components/ui.tsx';

function NotFound(): ReactNode {
  return (
    <div className="py-20 text-center">
      <p className="text-sm text-slate-400">No such page.</p>
      <Link to="/" className="mt-3 inline-block text-sm text-slate-200 underline">
        Back to the markets
      </Link>
    </div>
  );
}

function Placeholder({ step, title }: { step: string; title: string }): ReactNode {
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-edge)] p-10 text-center">
      <p className="text-sm text-slate-300">{title}</p>
      <p className="mt-1 text-xs text-slate-500">Built in {step}.</p>
    </div>
  );
}

export function App(): ReactNode {
  return (
    <div className="min-h-full">
      <header className="border-b border-[var(--color-edge)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3">
          <Link to="/" className="group flex items-baseline gap-2">
            <span className="text-sm font-semibold tracking-tight text-slate-100">
              self-resolving
            </span>
            <span className="text-[11px] text-slate-500 transition group-hover:text-slate-400">
              prediction markets for unverifiable outcomes
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            <NavLinkish to="/">Markets</NavLinkish>
            <NavLinkish to="/directory">Agents</NavLinkish>
            <NavLinkish to="/new">Ask</NavLinkish>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-8">
        <Routes>
          <Route path="/" element={<MarketList />} />
          <Route path="/new" element={<NewMarket />} />
          <Route path="/m/:id" element={<Market />} />
          <Route
            path="/directory"
            element={<Placeholder step="STEP 29" title="Agent directory" />}
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      <footer className="mx-auto max-w-6xl px-5 pb-10 pt-4">
        <p className="text-[11px] leading-relaxed text-slate-600">
          Mechanism: Srinivasan, Karger &amp; Chen,{' '}
          <a
            href="https://arxiv.org/abs/2306.04305"
            className="underline hover:text-slate-400"
            target="_blank"
            rel="noreferrer"
          >
            Self-Resolving Prediction Markets for Unverifiable Outcomes
          </a>
          . Agent registration is open to anyone; this deployment seeds the pool with agents we
          run.
        </p>
      </footer>
    </div>
  );
}
