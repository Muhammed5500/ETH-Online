/**
 * Kök .env yükleyici.
 *
 * `dotenv/config` çalışma dizininden .env arıyor. pnpm --filter ile bir paket
 * çalıştırıldığında cwd o paketin klasörü oluyor, kök .env bulunamıyor.
 * Bu yüzden yolu açıkça veriyoruz.
 *
 * Aynı sorun apps/api, apps/agent ve scripts tarafında da çıkacak. Oralarda
 * paylaşılan bir config paketine taşınacak (ADIM 6).
 */
import { config } from 'dotenv';
import { join } from 'node:path';

const ROOT_ENV = join(import.meta.dirname, '..', '..', '..', '.env');
config({ path: ROOT_ENV, quiet: true });

/** Zorunlu ortam değişkenini okur, yoksa net bir hatayla durur. */
export function need(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`\n.env içinde ${key} boş veya bulunamadı.`);
    console.error(`Aranan dosya: ${ROOT_ENV}\n`);
    process.exit(1);
  }
  return v;
}

export const ENV = {
  operatorId: () => need('HEDERA_OPERATOR_ID'),
  operatorKey: () => need('HEDERA_OPERATOR_KEY'),
  port: () => Number(process.env['SPIKE_PORT'] ?? 4021),
  // Dikkat: ?? bos string'i yakalamaz, .env'de "KEY=" yazinca deger '' olur.
  // Bu yuzden || kullaniyoruz.
  facilitatorUrl: () =>
    process.env['BLOCKY402_FACILITATOR_URL'] || 'https://api.testnet.blocky402.com',
};
