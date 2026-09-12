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
import { Directory } from './pages/Directory.tsx';
import { NavLinkish } from './components/ui.tsx';
import { useWallet } from './lib/useWallet.tsx';

/**
 * Connect a wallet, and show which account is paying.
 *
 * Opening a market costs a deposit, and the deposit is paid over x402 by the
 * account connected here. Nothing else on the site needs a wallet: reading is
 * free, and the payment stack is only fetched when this button is pressed.
 */
function WalletButton(): ReactNode {
  const wallet = useWallet();

  if (wallet.status === 'unconfigured') {
    return (
      <span
        title="Set VITE_WALLETCONNECT_PROJECT_ID in .env — pairing goes through WalletConnect's relay, which needs a project id."
        className="rounded px-2.5 py-1.5 text-sm text-slate-600"
      >
        Wallet unconfigured
      </span>
    );
  }

  if (wallet.status === 'connected') {
    return (
      <button
        onClick={() => void wallet.disconnect()}
        title="Disconnect"
        className="rounded border border-[var(--color-edge)] px-2.5 py-1.5 font-mono text-xs text-slate-300 transition hover:border-slate-600 hover:text-slate-100"
      >
        {wallet.accountId}
      </button>
    );
  }

  return (
    <button
      onClick={() => void wallet.connect()}
      disabled={wallet.status === 'connecting'}
      className="rounded bg-slate-100 px-2.5 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
    >
      {wallet.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
    </button>
  );
}

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
            <span className="ml-2">
              <WalletButton />
            </span>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-8">
        <Routes>
          <Route path="/" element={<MarketList />} />
          <Route path="/new" element={<NewMarket />} />
          <Route path="/m/:id" element={<Market />} />
          <Route path="/directory" element={<Directory />} />
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
