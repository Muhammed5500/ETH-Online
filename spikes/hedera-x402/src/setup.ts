/**
 * SPIKE A adım 1/3 — alıcı hesabı oluştur.
 *
 * x402'de ödeyen (payer) ile alan (payTo) farklı hesaplar olmak zorunda.
 * Elimizde tek hesap var (operator), o yüzden ödemeyi alacak ikinci bir
 * hesabı operator üzerinden açıyoruz.
 *
 * Bu, ADIM 12'deki treasury oluşturmanın minimal provası.
 */
import { ENV } from './env.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
} from '@hashgraph/sdk';

const OUT = join(import.meta.dirname, '..', 'receiver.json');

async function main(): Promise<void> {
  const operatorId = AccountId.fromString(ENV.operatorId());
  const operatorKey = PrivateKey.fromStringECDSA(ENV.operatorKey());
  const client = Client.forTestnet().setOperator(operatorId, operatorKey);

  console.log('Alıcı hesabı oluşturuluyor...');

  const receiverKey = PrivateKey.generateECDSA();
  const tx = await new AccountCreateTransaction()
    .setKeyWithoutAlias(receiverKey.publicKey)
    .setInitialBalance(new Hbar(1))
    .execute(client);

  const receipt = await tx.getReceipt(client);
  const receiverId = receipt.accountId!.toString();

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        accountId: receiverId,
        privateKey: receiverKey.toStringRaw(),
        publicKey: receiverKey.publicKey.toStringRaw(),
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  console.log(`\nAlıcı hesabı: ${receiverId}`);
  console.log(`Kaydedildi:   ${OUT}  (gitignore'da)`);
  console.log(`\nHashScan:     https://hashscan.io/testnet/account/${receiverId}\n`);

  client.close();
}

main().catch((e) => {
  console.error('Hata:', e);
  process.exit(1);
});
