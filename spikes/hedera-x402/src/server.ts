/**
 * SPIKE A adım 2/3 — x402 ile korunan endpoint.
 *
 * Doğrulanacak: Hedera testnet üzerinde bir endpoint x402 ile ücretlendirilebiliyor
 * mu, Blocky402 facilitator verify + settle yapıyor mu.
 *
 * Bu spike'ın sonucu ADIM 15'in (x402 ile korunan API endpointleri) temelini
 * belirliyor. Çalışmazsa Hedera track'i düşer.
 */
import { ENV } from './env.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { paymentMiddlewareFromConfig } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { RoutesConfig } from '@x402/core/server';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import { HBAR_ASSET_ID, HEDERA_TESTNET_CAIP2 } from '@x402/hedera';

const PORT = ENV.port();
const FACILITATOR_URL = ENV.facilitatorUrl();

// 0.001 HBAR = 100_000 tinybar
const PRICE_TINYBAR = '100000';

const receiver = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'receiver.json'), 'utf-8'),
) as { accountId: string };

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

const routes: RoutesConfig = {
  'GET /paid-hello': {
    accepts: {
      scheme: 'exact',
      network: HEDERA_TESTNET_CAIP2,
      payTo: receiver.accountId,
      price: { asset: HBAR_ASSET_ID, amount: PRICE_TINYBAR },
    },
    description: 'ADIM 2 SPIKE A — x402 ile ücretlendirilmiş hello world',
    mimeType: 'application/json',
  },
};

const app = express();
app.use(express.json());

// Basit istek günlüğü — 402 akışını gözle görmek için
app.use((req, _res, next) => {
  const paid = req.headers['x-payment'] ? ' [X-PAYMENT var]' : '';
  console.log(`  -> ${req.method} ${req.path}${paid}`);
  next();
});

app.use(
  paymentMiddlewareFromConfig(routes, facilitator, [
    { network: HEDERA_TESTNET_CAIP2, server: new ExactHederaScheme() },
  ]),
);

app.get('/paid-hello', (_req, res) => {
  res.json({
    message: 'Ödeme alındı, korumalı içerik burada.',
    paidAt: new Date().toISOString(),
  });
});

// Ücretsiz kontrol endpoint'i
app.get('/health', (_req, res) => {
  res.json({ ok: true, facilitator: FACILITATOR_URL, payTo: receiver.accountId });
});

app.listen(PORT, () => {
  console.log('\nSPIKE A — x402 server');
  console.log('='.repeat(52));
  console.log(`  Port:        ${PORT}`);
  console.log(`  Facilitator: ${FACILITATOR_URL}`);
  console.log(`  Ağ:          ${HEDERA_TESTNET_CAIP2}`);
  console.log(`  payTo:       ${receiver.accountId}`);
  console.log(`  Fiyat:       ${PRICE_TINYBAR} tinybar (0.001 HBAR)`);
  console.log('='.repeat(52));
  console.log('\nBaşka bir terminalde:  pnpm --filter @ethonline/spike-hedera-x402 client\n');
});
