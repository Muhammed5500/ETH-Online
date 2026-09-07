# Adım Kayıt Defteri

Her adımın sonunda TEST KAPISI geçildiğinde buraya kayıt düşülür. Bu dosya iki işe yarıyor: nerede kaldığını hatırlatıyor, ve ADIM 32'de README yazarken "ne zordu" bölümleri buradan çıkıyor.

---

## ADIM 1 — Monorepo İskeleti

- **Tarih:** 2026-09-07
- **Durum:** GEÇTİ
- **Test:** 6 yazıldı, 6 geçti, 0 kaldı
- **Tam suite:** 6/6 yeşil (502 ms)

### Kullanılan sürümler

| Araç | Sürüm |
|---|---|
| Node | 24.9.0 |
| pnpm | 10.28.2 |
| TypeScript | 5.9.3 |
| vitest | 3.2.7 |
| tsx | 4.23.13 |
| @types/node | 24.13.3 |
| git | 2.51.1.windows.1 |

### Yapılan

- pnpm workspace kuruldu: `packages/*` (core, hedera, graph, ens) + `apps/*` (api, agent, web)
- vitest iki ayrı konfigürasyon:
  - `vitest.config.ts` — birim testleri, ağa çıkmaz, `*.integration.test.ts` hariç tutuluyor
  - `vitest.integration.config.ts` — testnet gerektirenler, timeout 300 sn
- Deterministik test kaynakları yazıldı: `SeededRandom` (mulberry32) ve `ScriptedRandom`
- `.env.example` — Hedera, Graph, ENS, LLM anahtarları + protokol parametreleri
- Makale `docs/paper/` altına taşındı (PDF + LaTeX matematikli tam metin)
- `.gitignore` — `agents/accounts.json` ve `agents/*.key` özellikle dışlandı

### Doğrulama çıktıları

```
pnpm install            ✓ 55 paket, 15.7 sn
pnpm build              ✓ 7 workspace projesi, hepsi Done
pnpm test               ✓ 6/6 yeşil, 502 ms
pnpm test:integration   ✓ 0 test (henüz yok), exit 0
workspace symlink       ✓ apps/api/node_modules/@ethonline/{core,hedera,graph,ens}
```

### ROADMAP'ten sapmalar

**1. Paket `build` scriptleri `tsc --noEmit` yapıyor, `dist` üretmiyor.**

Çalışma zamanı `tsx` ile doğrudan TypeScript kaynaktan olacak. Sebep: monorepo'da build sırası, project reference ve dist/kaynak ikiliği iki hafta boyunca sürekli vergi alıyor. Yayınlanacak paket yok, dolayısıyla derleme çıktısına ihtiyaç da yok. `pnpm build` yine de gerçek bir tip kontrolü yapıyor, yani kapı işlevini koruyor.

**2. Paketler birbirine `main: ./src/index.ts` üzerinden bağlanıyor.**

pnpm workspace symlink'i üzerinden doğrudan kaynak çözülüyor. Böylece vitest alias konfigürasyonuna, tsconfig `paths` ayarına ve build sırası yönetimine hiç gerek kalmadı. Symlink'lerin kurulduğu doğrulandı.

### Tuzaklar

**OneDrive senkronu.** Repo OneDrive klasörü içinde. `node_modules` on binlerce küçük dosya üretiyor ve OneDrive bunları senkronlamaya çalışırsa `pnpm install` kilitlenebilir, dosya erişim hataları çıkabilir.

Önlem: OneDrive ayarlarından bu klasörü senkron dışı bırak (Ayarlar → Hesap → Klasör seç), ya da en azından `node_modules`'u. Şu an sorun çıkmadı ama paket sayısı arttıkça risk büyüyor. `@hashgraph/sdk` ve Next.js kurulunca (ADIM 12 ve 27) tekrar kontrol et.

**esbuild build script uyarısı.** pnpm `esbuild@0.28.2` post-install scriptini güvenlik gereği atladı. vitest yine de sorunsuz çalıştı çünkü Windows'ta binary `@esbuild/win32-x64` optional dependency'si içinde hazır geliyor. Şu an aksiyon gerekmiyor; ileride esbuild kaynaklı bir hata görürsen `pnpm approve-builds` çalıştır.

### Kalan risk

Yok. Sonraki adım (ADIM 2, Hedera x402 spike) bu iskeletten bağımsız, `spikes/` altında ayrı çalışacak.

---

## ADIM 2 ÖNCESİ — Hedera ön uçuş kontrolü

- **Tarih:** 2026-09-07
- **Durum:** GEÇTİ (7/7)
- **Komut:** `pnpm check:hedera` (`scripts/check-hedera.ts`)

Bu ROADMAP'te ayrı bir adım değildi, ADIM 2'ye girmeden zemini temizlemek için eklendi.
Sadece bağlantı testi değil: ADIM 13 ve ADIM 14'ün dayandığı yetenekleri de doğruluyor.

### Sonuçlar

| Kontrol | Sonuç |
|---|---|
| Anahtar ECDSA olarak ayrıştırıldı | ✓ |
| Bakiye | ✓ 1000 HBAR |
| Hesap tam (hollow değil), zincirdeki anahtar yerelle eşleşiyor | ✓ |
| Ücret ödeyip işlem yapabiliyor (HCS topic açıldı) | ✓ |
| HCS mesajı yazıldı, sequence number döndü | ✓ |
| **Running hash receipt ile döndü** | ✓ **48 byte** |
| Hash -> [0,1) dönüşümü | ✓ u = 0.689840 |

### En kritik bulgu

**Running hash receipt ile geliyor, 48 byte.** ADIM 14'ün tamamı buna dayanıyordu ve
plandaki en riskli bilinmeyendi. Gelmeseydi durma zarı için harici bir kaynağa (drand)
ya da mirror node sorgusuna geçmek gerekecekti, bu da mimariyi ve Hedera anlatımını
değiştirirdi. 1. günde yeşil.

`Buffer.readBigUInt64BE()` ile ilk 8 byte'ı alıp 2^64'e bölmek çalışıyor. ADIM 14'teki
`hashToUnitInterval` bu şekilde yazılacak.

### ADIM 13 için not

Preflight topic'i silinemedi. Sebep: `TopicCreateTransaction` admin key verilmeden
çağrılırsa **değiştirilemez ve silinemez** bir topic üretiyor.

ADIM 13'te karar verilecek: market topic'leri kalıcı olsun (admin key yok, daha güçlü
değiştirilemezlik iddiası) ya da yönetilebilir olsun (`setAdminKey`, test sırasında
temizlik yapılabilir). Denetim izi iddiası açısından **admin key vermemek daha güçlü**:
topic'i sonradan kimse silemez, yani rapor defteri gerçekten kalıcı. Öneri: admin key
verme, test topic'lerini birikmeye bırak.

Kalan artık: `0.0.10409150` (testnet, önemsiz).

### Kurulum notları

- `@hashgraph/sdk` kurulumu 2 dk 54 sn sürdü. OneDrive senkronu şüpheli. Next.js
  kurulunca (ADIM 27) daha da yavaşlarsa klasörü senkron dışı bırakmak gerekecek.
- pnpm `protobufjs` build scriptlerini atladı (`esbuild` gibi). SDK sorunsuz çalıştı,
  şimdilik aksiyon gerekmiyor.
