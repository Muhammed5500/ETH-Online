/**
 * SPIKE A adım 3/3 — ödeme yapan client.
 *
 * İki istek atıyor:
 *   1. Ödemesiz, çıplak fetch  -> 402 beklenir
 *   2. x402 ile sarmalanmış    -> 200 beklenir, settlement bilgisi header'da
 *
 * İkinci istek gerçekten zincir üstünde HBAR transferi yapıyor. Bu spike'ın
 * amacı ADIM 15 ve ADIM 22'de kullanacağımız akışın çalıştığını kanıtlamak.
 */
import { ENV } from './env.js';
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { createClientHederaSigner, ExactHederaScheme, HBAR_ASSET_ID, HEDERA_TESTNET_CAIP2, PrivateKey } from '@x402/hedera';

const PORT = ENV.port();
const URL_ = `http://localhost:${PORT}/paid-hello`;

let failures = 0;
function step(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'GECTI' : 'KALDI'}] ${name}`);
  if (detail) console.log(`          ${detail}`);
}

async function main(): Promise<void> {
  console.log('\nSPIKE A — x402 client\n' + '='.repeat(52));

  // 1) Ödemesiz istek -> 402 olmalı
  try {
    const res = await fetch(URL_);
    const body = await res.text();
    step('Ödemesiz istek 402 dönüyor', res.status === 402, `status: ${res.status}, gövde: ${body.slice(0, 120)}`);
  } catch (e) {
    step('Ödemesiz istek 402 dönüyor', false, String(e));
  }

  // 2) x402 ile ödeyerek istek -> 200 olmalı
  const accountId = ENV.operatorId();
  const privateKey = PrivateKey.fromStringECDSA(ENV.operatorKey());

  const signer = createClientHederaSigner(accountId, privateKey, {
    network: HEDERA_TESTNET_CAIP2,
  });

  // Harcama kontrolleri: varsayilan olarak SADECE "default asset"lere (USDC gibi)
  // izin veriliyor. HBAR (0.0.0) default asset degil, o yuzden acikca izin listesine
  // ekliyoruz. Tavani da koyuyoruz — ADIM 20'de agent'lar veri sorgusu icin odeme
  // yapacak ve sinirsiz harcama yetkisi vermek istemiyoruz.
  const client = x402Client.fromConfig({
    schemes: [{ network: HEDERA_TESTNET_CAIP2, client: new ExactHederaScheme(signer) }],
    spendControls: {
      allowedAssets: [
        {
          network: HEDERA_TESTNET_CAIP2,
          asset: HBAR_ASSET_ID,
          maxAmountPerPayment: '10000000', // 0.1 HBAR tavan
        },
      ],
    },
  });
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  console.log(`\n  Ödeyen hesap: ${accountId}`);
  console.log('  Ödeme yapılıyor, zincir üstü işlem birkaç saniye sürebilir...\n');

  try {
    const res = await fetchWithPay(URL_);
    const body = await res.text();
    step('Ödemeli istek 200 dönüyor', res.status === 200, `gövde: ${body.slice(0, 160)}`);

    // Header adi surumler arasinda degisiyor: X-PAYMENT-RESPONSE ve payment-response
    // ikisi de kodda geciyor. Ikisini de deniyoruz, bulunamazsa hepsini dokuyoruz.
    const h1 = res.headers.get('x-payment-response');
    const h2 = res.headers.get('payment-response');
    console.log(`          [header teshis] x-payment-response=${h1 ? 'VAR' : 'yok'}  payment-response=${h2 ? 'VAR' : 'yok'}`);
    const header = h1 ?? h2;
    if (!header) {
      console.log('\n  Gelen tüm headerlar:');
      res.headers.forEach((v, k) => console.log(`    ${k}: ${v.slice(0, 120)}`));
      console.log('');
    }
    if (header) {
      const decoded = decodePaymentResponseHeader(header);
      const txId = (decoded as Record<string, unknown>)['transaction'] ?? (decoded as Record<string, unknown>)['transactionId'];
      step('Settlement bilgisi header ile döndü', true, JSON.stringify(decoded).slice(0, 300));
      if (typeof txId === 'string') {
        console.log(`\n  HashScan: https://hashscan.io/testnet/transaction/${txId}`);
      }
    } else {
      step('Settlement bilgisi header ile döndü', false, 'x-payment-response header yok');
    }
  } catch (e) {
    step('Ödemeli istek 200 dönüyor', false, String(e));
  }

  console.log('\n' + '='.repeat(52));
  if (failures === 0) {
    console.log('SPIKE A YEŞİL — Hedera x402 uçtan uca çalışıyor.\n');
  } else {
    console.log(`SPIKE A: ${failures} kontrol başarısız.\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nBeklenmeyen hata:', e);
  process.exit(1);
});
