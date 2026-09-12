/**
 * Undoing what a handler did when the payment for it never settled.
 *
 * THE HOLE THIS CLOSES, AND HOW IT WAS FOUND. `@x402/express` runs a paid
 * route in this order:
 *
 *     verify -> HANDLER -> buffer the response -> settle -> release or 402
 *
 * The handler therefore runs before the money moves. If settlement then fails
 * the library throws the buffered response away and answers 402 — but nothing
 * undoes what the handler already wrote. The caller is told it did not pay,
 * and the server behaves as though it did.
 *
 * That is not theoretical. On 2026-09-12 a full on-chain run recorded twenty
 * bonds while only eighteen payments reached the treasury: agent-01 and
 * agent-15 joined the pool for nothing, and settlement paid both of them their
 * bond back. The treasury closed exactly 2 HBAR down and the run's own
 * treasury invariant is what caught it.
 *
 * A handler answering 4xx is already safe: the library cancels the payment
 * instead of settling it. The only gap is a handler that SUCCEEDED against a
 * payment that did not.
 *
 * WHY NOT SETTLE FIRST INSTEAD. The Hedera scheme also offers an `upfront`
 * flow, where the money moves before the handler. That swaps this failure for
 * its mirror image: the payer is charged and the handler then fails, so money
 * exists with no state behind it. For a mechanism whose central claim is a
 * closed loop, an unfunded participant inside the market is far worse than a
 * payment sitting in the treasury with nothing attached to it, and it is the
 * one an operator cannot see. So the ordering stays and the effect is made
 * conditional instead.
 *
 * WHAT A ROLLBACK MAY AND MAY NOT DO. It undoes local state. It cannot unwrite
 * HCS: a market whose deposit failed to settle leaves its topic behind with a
 * single `market-open` message and nothing after it. That orphan is honest —
 * nobody else can append to the topic, and a reader can see the market never
 * ran — and it is cheaper than inventing a message type to describe a payment
 * that did not happen.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** One reversible effect, with the words to log if it has to be reversed. */
interface PendingEffect {
  readonly what: string;
  readonly undo: () => void;
}

/**
 * Where the effects live.
 *
 * On `res.locals` rather than in a module-level map: a request's undo list has
 * exactly the lifetime of its response, and anything module-level would need a
 * cleanup path that leaks the day somebody forgets it.
 */
interface RollbackLocals extends Record<string, unknown> {
  x402Effects?: PendingEffect[];
}

function localsOf(res: Response): RollbackLocals {
  return res.locals as RollbackLocals;
}

/**
 * Registers something to undo if this request's payment does not settle.
 *
 * Called by a handler AFTER it has mutated state and BEFORE it responds. On a
 * route with no payment gate nothing ever calls the undo, which is correct:
 * with no gate there is no payment to fail.
 */
export function onPaymentFailure(res: Response, what: string, undo: () => void): void {
  const locals = localsOf(res);
  (locals.x402Effects ??= []).push({ what, undo });
}

export interface RollbackReport {
  readonly method: string;
  readonly path: string;
  readonly what: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface RollbackOptions {
  /** Told about every reversal, and about every reversal that itself failed. */
  readonly onRollback?: (report: RollbackReport) => void;
}

/**
 * Wraps the payment gate so a 402 undoes whatever the handler did.
 *
 * 402 is the only status that means "the money did not move" after a handler
 * has run — the library sends it both for an unpaid request, where no effect
 * was ever registered, and for a settlement failure, where one was.
 *
 * THE UNDO RUNS BEFORE THE RESPONSE GOES OUT, AND THAT ORDER IS THE POINT.
 * Doing it on `finish` looks equivalent and loses a race: a client that reads
 * the 402 and immediately retries can reach the bond route again while the old
 * bond is still recorded, get `409 Already bonded`, and take that as proof it
 * had paid — which is the same unfunded agent this file exists to prevent,
 * arriving by a different door. So `res.end` is wrapped and the undo happens
 * on the way out, before a single byte is written.
 *
 * The `finish` listener stays as a backstop for a response that somehow
 * completes without going through `end`. It is cheap, and the undo list is
 * emptied once, so it cannot run twice.
 *
 * `close` is deliberately NOT used: a client that hangs up mid-response tells
 * us nothing about whether the payment settled, and rolling back a paid bond
 * because somebody shut a laptop is a worse failure than the one being fixed.
 * Those are left to the treasury invariant at settlement.
 *
 * Undos run in reverse order and never throw. A rollback that fails is
 * reported and the next one still runs: a half-undone request is worse than a
 * fully undone one.
 */
export function withPaymentRollback(
  gate: RequestHandler,
  opts: RollbackOptions = {},
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const runUndos = (): void => {
      if (res.statusCode !== 402) return;
      const effects = localsOf(res).x402Effects;
      if (!effects || effects.length === 0) return;

      // Emptied first: an undo that throws must not leave the list behind for
      // the backstop to run a second time.
      const pending = [...effects].reverse();
      effects.length = 0;

      for (const effect of pending) {
        try {
          effect.undo();
          opts.onRollback?.({ method: req.method, path: req.path, what: effect.what, ok: true });
        } catch (e) {
          opts.onRollback?.({
            method: req.method,
            path: req.path,
            what: effect.what,
            ok: false,
            error: (e as Error).message,
          });
        }
      }
    };

    // Wrapped here, before the gate runs, so the library's own buffering sits
    // INSIDE this one: whatever it finally releases passes through here first.
    //
    // Untyped on purpose. `res.end` carries three overloads and the wrapper
    // does not care which one is being used — it forwards them all unchanged
    // and adds one call in front.
    type AnyEnd = (...args: unknown[]) => unknown;
    const patchable = res as unknown as { end: AnyEnd };
    const originalEnd = patchable.end.bind(res);
    patchable.end = (...args: unknown[]): unknown => {
      runUndos();
      return originalEnd(...args);
    };

    res.on('finish', runUndos);

    return gate(req, res, next);
  };
}

/** Default reporter: an operator has to see this, it is money not arriving. */
export function logRollback(report: RollbackReport): void {
  const head = `[x402] payment did not settle for ${report.method} ${report.path}`;
  if (report.ok) {
    console.warn(`${head} — rolled back: ${report.what}`);
  } else {
    console.error(
      `${head} — COULD NOT ROLL BACK ${report.what}: ${report.error ?? 'unknown'}. ` +
        `State exists that was never paid for; check it by hand.`,
    );
  }
}
