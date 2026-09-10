/**
 * The small shared pieces.
 *
 * Kept in one file because there are only a handful and each is a few lines;
 * a directory of one-component files would be more filing than code.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { MarketStatus } from '../lib/api.ts';
import { sliceColor } from '../lib/format.ts';

/**
 * The five states a market can be in.
 *
 * `cancelled` is not a failure and should not read as one: it means the
 * bonding window closed under `minPoolSize` and everyone was refunded in full.
 * A market that cannot reach a real pool is better not run at all, so this is
 * the mechanism working.
 */
const STATUS_STYLE: Record<MarketStatus, { label: string; className: string; title: string }> = {
  bonding: {
    label: 'bonding',
    className: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
    title: 'Agents are posting bonds. No reports yet.',
  },
  running: {
    label: 'running',
    className: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
    title: 'Agents are being drawn and reporting, one at a time.',
  },
  closed: {
    label: 'closed',
    className: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
    title: 'The stopping dice landed. Waiting on settlement.',
  },
  settled: {
    label: 'settled',
    className: 'bg-violet-500/15 text-violet-300 ring-violet-500/30',
    title: 'Payouts computed and paid.',
  },
  cancelled: {
    label: 'cancelled',
    className: 'bg-slate-500/15 text-slate-400 ring-slate-500/30',
    title: 'The pool never reached its minimum. Everyone was refunded in full.',
  },
};

export function StatusBadge({ status }: { status: MarketStatus }): ReactNode {
  const s = STATUS_STYLE[status];
  return (
    <span
      title={s.title}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s.className}`}
    >
      {s.label}
    </span>
  );
}

export function SliceBadge({ id }: { id: string }): ReactNode {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${sliceColor(id)}`}
    >
      {id}
    </span>
  );
}

export function Panel({
  title,
  children,
  aside,
}: {
  title?: string;
  children: ReactNode;
  aside?: ReactNode;
}): ReactNode {
  return (
    <section className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)]">
      {title && (
        <header className="flex items-center justify-between border-b border-[var(--color-edge)] px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
          {aside}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A label/value pair. `mono` for anything that is an id or a number. */
export function Field({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  mono?: boolean;
}): ReactNode {
  return (
    <div>
      <dt className="text-xs text-slate-500" title={hint}>
        {label}
      </dt>
      <dd className={`mt-0.5 text-sm text-slate-200 tnum ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }): ReactNode {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-600 border-t-slate-300" />
      {label}
    </div>
  );
}

/**
 * An error the reader can act on.
 *
 * The API distinguishes "fix your request" from "the payment rail is having a
 * moment" (STEP 17), and that distinction is worth keeping all the way to the
 * screen: one asks the reader to change something, the other asks them to wait.
 */
export function ErrorBox({
  title,
  detail,
  retry,
}: {
  title: string;
  detail?: string;
  retry?: () => void;
}): ReactNode {
  return (
    <div className="rounded-lg border border-rose-900/60 bg-rose-950/30 p-4">
      <p className="text-sm font-medium text-rose-200">{title}</p>
      {detail && <p className="mt-1 text-xs text-rose-300/80">{detail}</p>}
      {retry && (
        <button
          onClick={retry}
          className="mt-3 rounded border border-rose-800 px-2 py-1 text-xs text-rose-200 hover:bg-rose-900/40"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <p className="py-8 text-center text-sm text-slate-500">{children}</p>;
}

export function NavLinkish({ to, children }: { to: string; children: ReactNode }): ReactNode {
  return (
    <Link
      to={to}
      className="rounded px-2.5 py-1.5 text-sm text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
    >
      {children}
    </Link>
  );
}
