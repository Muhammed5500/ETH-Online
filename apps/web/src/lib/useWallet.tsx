/**
 * Wallet state for the app, and the reason it is loaded the way it is.
 *
 * THE PAYMENT STACK IS NEVER IN THE FIRST LOAD. `wallet.ts` pulls in the
 * Hedera SDK, the x402 client and WalletConnect, which together are several
 * times the size of this entire application. Almost nobody who opens the page
 * pays for anything, so it is fetched by dynamic `import()` the first time
 * someone actually asks to connect. Everything referenced from this file at
 * the top level is `import type`, which is erased and pulls in nothing.
 *
 * THE PROJECT ID IS NOT A SECRET AND IS STILL REQUIRED. Pairing goes through
 * WalletConnect's relay, so without one the modal cannot open. It is read from
 * the environment and the UI says so plainly when it is missing, rather than
 * failing at the moment of the click with something unreadable.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { FetchLike } from './api.ts';
import type { WalletConnection } from './wallet.ts';

export type WalletStatus = 'unconfigured' | 'disconnected' | 'connecting' | 'connected';

export interface WalletState {
  readonly status: WalletStatus;
  readonly accountId?: string;
  readonly error?: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * A `fetch` that pays, or undefined when no wallet is connected.
   *
   * Undefined rather than a throwing stub: a caller has to decide what to do
   * without a wallet, and the honest answer on this app is "send the request
   * unpaid and let the API answer 402", which is what the demo server accepts
   * and what the real server correctly refuses.
   */
  readonly payingFetch?: FetchLike;
}

/**
 * Dot access, not `import.meta.env['...']`.
 *
 * Vite inlines these by substituting the literal text `import.meta.env.VITE_X`
 * at build time. Written with brackets it is left as a runtime lookup against
 * an object that does not carry the value, so the id reads as undefined even
 * when it is set — and the button says "unconfigured" with nothing to show for
 * it. The bracket form was only there out of habit; `noPropertyAccessFromIndex
 * Signature` is not enabled in this repo, so dot access was always allowed.
 */
const PROJECT_ID = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ?? '';

const WalletContext = createContext<WalletState | undefined>(undefined);

export function WalletProvider({ children }: { children: ReactNode }): ReactNode {
  const [connection, setConnection] = useState<WalletConnection | undefined>(undefined);
  const [payer, setPayer] = useState<FetchLike | undefined>(undefined);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const connect = useCallback(async (): Promise<void> => {
    if (!PROJECT_ID) {
      setError(
        'VITE_WALLETCONNECT_PROJECT_ID is not set, so the wallet modal cannot open. ' +
          'Create a free project at reown.com and put the id in .env.',
      );
      return;
    }
    setConnecting(true);
    setError(undefined);
    try {
      // The whole payment stack arrives here and nowhere else.
      const wallet = await import('./wallet.ts');
      const connector = wallet.createConnector(PROJECT_ID);
      const result = await wallet.connectWallet(connector);
      setConnection(result);
      // The arrow is required, not stylistic: `useState` treats a function
      // argument as an updater and stores what it returns. Passing the fetch
      // directly would have React call it with the previous state.
      setPayer(() => wallet.payingFetch(result.signer, result.accountId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async (): Promise<void> => {
    const current = connection;
    setConnection(undefined);
    setPayer(undefined);
    setError(undefined);
    if (!current) return;
    try {
      await current.connector.disconnectAll();
    } catch {
      // Already gone from the wallet's side, which is the same outcome. The
      // local state is cleared above either way, so a failure here must not
      // leave the button stuck saying "connected".
    }
  }, [connection]);

  const value = useMemo<WalletState>(
    () => ({
      status: !PROJECT_ID
        ? 'unconfigured'
        : connecting
          ? 'connecting'
          : connection
            ? 'connected'
            : 'disconnected',
      ...(connection ? { accountId: connection.accountId } : {}),
      ...(error ? { error } : {}),
      ...(payer ? { payingFetch: payer } : {}),
      connect,
      disconnect,
    }),
    [connection, payer, connecting, error, connect, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used inside a WalletProvider.');
  return ctx;
}
