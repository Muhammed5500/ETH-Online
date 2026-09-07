/**
 * Hedera ön uçuş kontrolü.
 *
 * Sadece "bağlanabiliyor muyum" demiyor. ADIM 13 (HCS rapor defteri) ve
 * ADIM 14 (running hash'ten rastgelelik) tam olarak buradaki yeteneklere
 * dayanıyor, o yüzden ikisini de şimdi doğruluyoruz. Running hash receipt'te
 * gelmiyorsa bunu 6. günde değil bugün öğrenmek istiyoruz.
 *
 * Çalıştır:  pnpm check:hedera
 */
import 'dotenv/config';
import {
  AccountBalanceQuery,
  AccountId,
  AccountInfoQuery,
  Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicDeleteTransaction,
  TopicMessageSubmitTransaction,
} from '@hashgraph/sdk';

const OK = 'GECTI';
const FAIL = 'KALDI';

let failures = 0;

function step(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`  [${ok ? OK : FAIL}] ${name}`);
  if (detail) console.log(`          ${detail}`);
}

function need(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`\n.env içinde ${key} boş. Doldurup tekrar çalıştır.`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  console.log('\nHedera ön uçuş kontrolü\n' + '='.repeat(50));

  const operatorId = AccountId.fromString(need('HEDERA_OPERATOR_ID'));
  const rawKey = need('HEDERA_OPERATOR_KEY');

  // 1) Anahtar ayrıştırma
  // fromString() ECDSA/ED25519 ayrımında belirsiz davranabiliyor ve yanlış
  // anahtar tipiyle sessizce ilerliyor. Açıkça ECDSA diyoruz.
  let operatorKey: PrivateKey;
  try {
    operatorKey = PrivateKey.fromStringECDSA(rawKey);
    step('Anahtar ayrıştırıldı (ECDSA)', true, `public: ${operatorKey.publicKey.toStringRaw().slice(0, 24)}...`);
  } catch (e) {
    step('Anahtar ayrıştırıldı (ECDSA)', false, String(e));
    process.exit(1);
  }

  const client = Client.forTestnet().setOperator(operatorId, operatorKey);

  // 2) Bakiye
  let hbar = 0;
  try {
    const bal = await new AccountBalanceQuery().setAccountId(operatorId).execute(client);
    hbar = bal.hbars.toBigNumber().toNumber();
    step('Bakiye okundu', hbar > 1, `${hbar} HBAR`);
  } catch (e) {
    step('Bakiye okundu', false, String(e));
  }

  // 3) Hesap bilgisi — hollow account mı, anahtar eşleşiyor mu
  try {
    const info = await new AccountInfoQuery().setAccountId(operatorId).execute(client);
    const onChainKey = info.key?.toString() ?? '';
    const localKey = operatorKey.publicKey.toString();
    const matches = onChainKey === localKey;
    step(
      'Hesap tam (hollow değil) ve anahtar eşleşiyor',
      matches,
      matches
        ? `EVM: ${info.contractAccountId ?? '-'}`
        : `ZİNCİRDEKİ anahtar yerel anahtarla eşleşmiyor.\n          zincir: ${onChainKey.slice(0, 40)}...\n          yerel : ${localKey.slice(0, 40)}...`,
    );
  } catch (e) {
    step('Hesap bilgisi okundu', false, String(e));
  }

  // 4) Ücret ödeyerek gerçek bir işlem — HCS topic oluştur
  let topicId: string | null = null;
  try {
    const rx = await (await new TopicCreateTransaction()
      .setTopicMemo('preflight')
      .execute(client)).getReceipt(client);
    topicId = rx.topicId?.toString() ?? null;
    step('Ücret ödeyip işlem yapabiliyor (HCS topic açıldı)', !!topicId, `topic: ${topicId}`);
  } catch (e) {
    step('Ücret ödeyip işlem yapabiliyor', false, String(e));
  }

  // 5) ADIM 13 + 14'ün kritik bağımlılığı: mesaj yaz, running hash al
  if (topicId) {
    try {
      const rx = await (await new TopicMessageSubmitTransaction()
        .setTopicId(topicId)
        .setMessage(JSON.stringify({ v: 1, type: 'preflight', ts: Date.now() }))
        .execute(client)).getReceipt(client);

      const seq = rx.topicSequenceNumber?.toNumber() ?? null;
      const hash = rx.topicRunningHash ?? null;

      step('HCS mesajı yazıldı, sequence number döndü', seq === 1, `sequence: ${seq}`);

      // ADIM 14 buna dayanıyor. Gelmiyorsa rastgelelik kaynağını değiştirmemiz gerekir.
      const hashOk = !!hash && hash.length >= 8;
      step(
        'Running hash receipt ile döndü (ADIM 14 buna dayanıyor)',
        hashOk,
        hashOk
          ? `${hash!.length} byte, ilk 8: ${Buffer.from(hash!.slice(0, 8)).toString('hex')}`
          : 'GELMEDI — durma zarı için alternatif kaynak gerekir (mirror node veya drand)',
      );

      if (hashOk) {
        // Running hash -> [0,1) dönüşümünün mantığını şimdi doğrula
        const u = Number(Buffer.from(hash!.slice(0, 8)).readBigUInt64BE()) / 2 ** 64;
        const inRange = u >= 0 && u < 1;
        step('Hash -> [0,1) dönüşümü çalışıyor', inRange, `u = ${u.toFixed(6)}  (alpha=0.125 ile ${u < 0.125 ? 'KAPANIRDI' : 'devam ederdi'})`);
      }
    } catch (e) {
      step('HCS mesajı yazıldı', false, String(e));
    }

    // Temizlik
    try {
      await (await new TopicDeleteTransaction().setTopicId(topicId).execute(client)).getReceipt(client);
      console.log(`\n  (preflight topic ${topicId} silindi)`);
    } catch {
      console.log(`\n  (preflight topic ${topicId} silinemedi, önemsiz)`);
    }
  }

  client.close();

  console.log('\n' + '='.repeat(50));
  if (failures === 0) {
    console.log('Tüm kontroller geçti. ADIM 2 (x402 spike) için zemin hazır.\n');
  } else {
    console.log(`${failures} kontrol başarısız. ADIM 2'ye geçmeden düzelt.\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nBeklenmeyen hata:', e);
  process.exit(1);
});
