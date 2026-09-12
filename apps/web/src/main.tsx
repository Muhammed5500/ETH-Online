import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { WalletProvider } from './lib/useWallet.tsx';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('No #root element in index.html.');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <WalletProvider>
        <App />
      </WalletProvider>
    </BrowserRouter>
  </StrictMode>,
);
