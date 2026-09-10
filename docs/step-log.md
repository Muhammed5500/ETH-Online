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

---

## ADIM 2 — SPIKE A: Hedera x402 Hello World

- **Tarih:** 2026-09-07
- **Durum:** YESIL
- **Komutlar:** `pnpm --filter @ethonline/spike-hedera-x402 run setup | run server | run client`

### Sonuc

Hedera testnet uzerinde x402 ile ucretlendirilmis endpoint **ucdan uca calisiyor.**
Odemesiz istek 402, odemeli istek 200, ve para gercekten zincirde tasiniyor.

Alici hesap `0.0.10409325`: 1 HBAR -> 1.005 HBAR. Bes odeme, hepsi mirror node'da
SUCCESS. Her biri 100.000 tinybar (0.001 HBAR).

Ornek settlement yaniti:
```json
{"success":true,"payer":"0.0.10407814",
 "transaction":"0.0.7162784@1788800025.853649623","network":"hedera:testnet"}
```

Islem kimligindeki `0.0.7162784` **facilitator'un fee payer hesabi**, bizim degil.
Yani gas'i facilitator odeyip islemi o gonderiyor; biz sadece kismi imzali transferi
uretiyoruz. ADIM 16'daki maliyet hesabinda bu onemli.

### Dogrulanan teknik gercekler (ADIM 15 ve 16 bunlara dayanacak)

| Konu | Deger |
|---|---|
| Paket hatti | `@x402/core`, `@x402/hedera`, `@x402/express`, `@x402/fetch` — **2.25.0** |
| Kullanilmayacak | `x402` / `x402-express` v1.2.0 (eski Coinbase hatti, Solana+CDP bagimli) |
| Facilitator | `https://api.testnet.blocky402.com` |
| CAIP-2 ag | `hedera:testnet` |
| HBAR asset id | `0.0.0`, miktarlar tinybar |
| Testnet USDC | `0.0.429274`, 6 ondalik |
| Server API | `paymentMiddlewareFromConfig(routes, HTTPFacilitatorClient, [{network, server}])` |
| Server semasi | `ExactHederaScheme` from `@x402/hedera/exact/server` |
| Client API | `x402Client.fromConfig({schemes, spendControls})` + `wrapFetchWithPayment` |
| Client semasi | `ExactHederaScheme` from `@x402/hedera` (kok export = client) |
| Imzalayici | `createClientHederaSigner(accountId, PrivateKey, {network})` |

### Uc tuzak (hepsi zaman yedi, ADIM 15'te tekrar etmesin)

**1. Settlement header'inin adi `payment-response`, `x-payment-response` DEGIL.**
Once yanlis ismi tahmin ettim, header bos dondu ve odeme basarisiz sanildi. Oysa odeme
basariliydi. Uc ardisik kosuda teshis ettim: `x-payment-response=yok`,
`payment-response=VAR`. Kod tabaninda iki isim de geciyor ama v2 akisinda gelen
`payment-response`. Cozmek icin `decodePaymentResponseHeader(header)` kullaniliyor.

**2. Client'in harcama kontrolleri HBAR'i varsayilan olarak REDDEDIYOR.**
Hata: `All payment requirements were rejected by spendControls: only default assets
or entries in spendControls.allowedAssets are allowed.` Varsayilan yalnizca "default
asset"lere (USDC gibi) izin veriyor, HBAR default degil.

Bunu `spendControls: false` ile kapatmak yerine **acikca izin listesine ekledik ve
tavan koyduk**:
```ts
spendControls: {
  allowedAssets: [{ network: 'hedera:testnet', asset: '0.0.0',
                    maxAmountPerPayment: '10000000' }],  // 0.1 HBAR tavan
}
```
Bu bir engel degil, ise yarayacak bir ozellik: ADIM 20'de agent'lar veri sorgusu icin
otonom odeme yapacak ve sinirsiz harcama yetkisi vermek istemiyoruz.

**3. dotenv calisma dizininden .env ariyor.**
`pnpm --filter X run Y` calistirinca cwd o paketin klasoru oluyor, kok `.env`
bulunamiyor ve degiskenler `undefined` geliyor. Hata mesaji bunu soylemiyor, sadece
`Cannot read properties of undefined` diyor.

Cozum `spikes/hedera-x402/src/env.ts`: yolu acikca veriyor ve eksik degiskende net
hata basiyor. **ADIM 6'da bu paylasilan bir config paketine tasinacak**, cunku ayni
sorun apps/api, apps/agent ve scripts tarafinda da cikacak.

### Iki kucuk not

- `pnpm --filter X <script>` bazi script adlarinda pnpm'in yerlesik komutlariyla
  cakisiyor (`setup`, `server` denendi, ikisi de `Unknown option: 'recursive'` verdi).
  **Her zaman `run` ile cagir:** `pnpm --filter X run <script>`.
- `.env`'de `KEY=` yazinca deger bos string olur, `undefined` degil. `??` bunu
  yakalamaz, `||` yakalar. Facilitator URL'i bu yuzden bos gitmisti.

### Kalan artik

Testnet hesaplari: alici `0.0.10409325`. `receiver.json` gitignore'da.

---

## ADIM 3 (SPIKE B) — ERTELENDI

- **Tarih:** 2026-09-08
- **Durum:** ERTELENDI (engel degil, risk buyuk olcude kalkti)

### Neden

The Graph'in **testnet gateway'i deploy edilmemis.** README'de listeleniyor ama
`testnet.gateway.thegraph.com` icin A kaydi yok (Google public DNS ile dogrulandi).
Denenen alternatifler de olu: `sepolia.gateway.thegraph.com`,
`gateway-testnet.thegraph.com`, `gateway-arbitrum-sepolia.thegraph.com`.

Yani x402 ile sorgu = gercek para. Karar kullaniciya birakildi, o da simdilik
atlanmasini istedi.

### Ertelenmesine ragmen ogrenilenler

Production gateway'e odemesiz istek atip 402'yi cozdum:

```json
{ "x402Version": 2,
  "accepts": [{ "scheme": "exact",
                "network": "eip155:8453",
                "asset":   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                "amount":  "10000",
                "payTo":   "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
                "extra": { "assetTransferMethod": "eip3009" } }] }
```

- Base mainnet, USDC, **$0.01 / sorgu**
- **eip3009 = gasless.** Odeyen imza atiyor, gas'i facilitator odiyor. ETH gerekmiyor.
- Paket: `@graphprotocol/client-x402` v1.0.0
- API: `createGraphQuery({ endpoint, chain })` -> `await query('{ ... }')`
- Env: `X402_PRIVATE_KEY`, `X402_CHAIN`

### Onerilen plan (beklemede)

Cift modlu: gelistirme ucretsiz Studio API key ile, demo/video x402 ile (~$1-2).
Gateway client zaten iki modlu tasarlanmisti (ADIM 18), ekstra is yok.
Gereken: Studio API key (ucretsiz) + Base aginda ~$10 USDC.

### Uyari

**SPIKE C (ENS, ADIM 4) cok geciktirilmemeli.** Orada gercek bilinmezlik var:
Sepolia kontrat adresleri dokumanda yok ve "admin rolleri sadece registration
aninda" kisiti deneyerek dogrulanmali. ENS kesilebilir parca ama kesme karari
12. gunde verilmemeli.

---

## ADIM 6 — Tipler, Konfigurasyon ve Parametre Dogrulama

- **Tarih:** 2026-09-08
- **Durum:** GECTI
- **Test:** 21 yazildi, 21 gecti
- **Tam suite:** 27/27 yesil

### Yazilanlar

`packages/core/src/types.ts` — Belief, MarketParams, Report, MarketState,
MarketStatus, ClosedReason, Payout, Settlement, RandomSource.

`packages/core/src/config.ts` — DEFAULT_PARAMS (PLAN.md Bolum 4 ile birebir),
validateParams, assertValidParams, normalizeBelief, beliefFromProbability,
poolExhaustionProbability, flatFeeProbability, suggestedAlpha.

### Tasarim kararlari

**Hata ile uyari ayrildi.** Hata mekanizmayi bozar (k=0 ise referans agent kendi
raporuna gore skorlanir), uyari ise calisan ama riskli yapilandirmadir (havuz sik
tukeniyor). Hata firlatir, uyari doner.

**`ClosedReason` ayri bir tip.** `stopping-rule` ile `pool-exhausted` ayirt
ediliyor, cunku ikincisi mekanizmanin varsayimini ihlal ediyor ve README'de
raporlanmasi gerekiyor.

**Core tamamen saf.** Ag, dosya, ortam degiskeni erisimi yok. dotenv sorunu
(SPIKE A'da cikan) burada cozulmedi — core'a node bagimliligi sokmamak icin ayri
tutuldu. apps/* tarafinda ele alinacak.

### Test kapisinda cikan hata

`poolExhaustionProbability` testinde beklenen sabitleri elle hesaplarken hata
yaptim: `1/6` icin 0.0293 yazmisim, dogrusu **0.031301**. `1/11` icin 0.1637
yazmisim, dogrusu **0.163508** (4 hanede tutmuyordu).

Formul dogruydu, testteki sabitler yanlisti. Testi duzelttim, kodu degil.
PLAN.md Bolum 4.1'deki tablo (%7.9 / %10.7 / %16.4) dogru cikti — uc deger de
kod tarafindan uretilenle birebir esiyor ve artik test ediliyor.

---

## ADIM 7 — CE-MSR Skorlama ve Kirpma

- **Tarih:** 2026-09-08
- **Durum:** GECTI
- **Test:** 17 yazildi, 17 gecti
- **Tam suite:** 44/44 yesil, build temiz

### Yazilanlar

`packages/core/src/scoring.ts` — clipBelief, crossEntropy, scoreCE, scoreCEM,
kl, totalCEM, maxTotalPayout.

### Kanitlanan degismezler

**DEGISMEZ 1 — Teleskoplama.** Rastgele 100 rapor dizisinde adim adim toplam ile
kapali form birebir esiyor:
`Sum_t S_CEM(r, q^t, q^(t-1)) = S_CE(r, q^son) - S_CE(r, q^0)` (tolerans 1e-10).

**DEGISMEZ 2 — Butce siniri.** Uniform prior ile toplam odeme hicbir rastgele
markette `log 2` asmiyor (100 kosu). Ayrica uniform olmayan prior'da da
`maxTotalPayout` gercek toplami her zaman ustten siniriliyor.

**DEGISMEZ 3 onizleme — bilgisiz denge.** Herkes bir oncekini kopyalarsa ilk
agent haric ödemeler tam sifir; ilk agent tam olarak `KL(r || q^0)` aliyor.
Paper Teorem 7'nin skorlama seviyesindeki karsiligi. Tam senaryo testi ADIM 11'de.

### Tasarim kararlari

**Kirpma zorunlu ve girdide yapiliyor.** `assertScorable` sifir iceren inanci
skorlamaya sokmuyor, hata mesajinda `clipBelief` uygulanmasi gerektigini
soyluyor. Paper Ek C.2'deki switching equilibrium'un matematigi tam olarak
`log(0) = -Inf`; kirpma olmadan tek agent sinirsiz skor uretebilir.

**`p0 = 1 - p1` olarak turetiliyor.** Boylece toplam BIREBIR 1 oluyor. Iki
bileseni ayri ayri kirpip normalize etmek daha "guzel" ondalik verirdi ama
kayan nokta hatasi birikirdi.

### Test kapisinda cikan hata

`clipBelief([1,0], 0.01)` icin `toEqual([0.99, 0.01])` yazmistim. IEEE754'te
`1 - 0.99 = 0.010000000000000009` oldugu icin kaldi. Kod dogru, test fazla
katiydi. `toBeCloseTo`'ya cevirdim ve ayrica **toplamin birebir 1 oldugunu**
dogrulayan yeni bir test ekledim — asil onemli olan ozellik o.

---

## ADIM 8 — Market State Machine

- **Tarih:** 2026-09-08
- **Durum:** GECTI
- **Test:** 23 market + 5 helper testi yazildi
- **Tam suite:** 72/72 yesil, build temiz

### Yazilanlar

`packages/core/src/market.ts` — `Market` sinifi, `createMarketState`.
`packages/core/test/helpers.ts` — yeni `LabelledRandom` kaynagi.

Akis: `bonding -> running -> closed`, veya `bonding -> cancelled`.

### Zorlanan dort kural

1. **Bir agent en fazla bir kez katilir.** Iki savunma hatti: `addBondedAgent`
   ayni id'yi reddediyor, `drawNextAgent` cekileni havuzdan siliyor.
2. **Sira onceden hesaplanmiyor.** Her turda `rng.next('draw-N')` ile tek agent.
3. **Timeout durma zarini ATLIYOR.** `ScriptedRandom.consumed` ile dogrulandi.
4. **Referans her zaman terminal agent.**

### Uc test kirmizi yandi, ucu de test kurgusu hatasiydi

**(a) Kucuk havuz + varsayilan k.** `minPoolSize: 3` verirken `k=3` birakmisim;
validator `minPoolSize > k+1` kuralini haklı olarak uygulayip reddetti.
Duzeltme: `SMALL_POOL = { k:1, T:1, alpha:0.5 }`.

**(b) ScriptedRandom hizasi kaydi — asil ogretici olan bu.** Timeout bir `draw`
tuketip `stop` tuketmiyor, dolayisiyla `[DRAW, NO_STOP, ...]` dizisi timeout'tan
sonra bir kayiyor ve `stop` beklenen yerde `DRAW=0` okunuyor. 0 < alpha oldugu
icin market beklenmedik sekilde kapaniyor. Test yesil kalsaydi bambaska bir seyi
olcuyor olacakti.

Cozum diziyi duzeltmek degil, daha saglam yardimci yazmak oldu: **LabelledRandom**
siraya degil **etikete** gore deger donduruyor (`draw-*`, `stop-*`, en uzun
eslesen on ek kazanir). Cagri sirasi degisince bozulmuyor. `ScriptedRandom` tek
bir yerde kaldi: tuketim sayimi gereken timeout testi.

### Build kapisi ise yaradi

Testler yesilken **build kirmiziydi**: `runningMarket` imzasi
`ScriptedRandom | SeededRandom` idi, `LabelledRandom` kabul etmiyordu. vitest
tipleri esbuild ile soydugu icin gormuyor. Imza `RandomSource` arayuzune
cevrildi. **Ders: `pnpm test` tek basina yeterli degil, `pnpm build` kapida
kalmali.**

### Dejenere durum notu (ADIM 9 icin)

Hic rapor gelmeden herkes timeout olursa market `closed` oluyor ama
`referenceReport` **undefined** kaliyor. Settlement bunu ele almali: skorlanacak
kimse yok, timeout olanlarin bond'u slash edilmis, kalan her sey asker'a iade.

---

## ADIM 9 — Settlement Hesaplayici

- **Tarih:** 2026-09-09
- **Durum:** GECTI
- **Test:** 18 settlement + 8 scoring (hamle limiti) yazildi
- **Tam suite:** 99/99 yesil, build temiz

### GERCEK TASARIM HATASI BULUNDU VE DUZELTILDI

Bu adimin en onemli ciktisi bir test kirmizisi degil, **mimari bir hata**.

Ilk uygulamada agent'in kaybi settlement'ta teminat seviyesinde KIRPILIYORDU.
Butce siniri testi bunu yakaladi:

```
Butce siniri asildi: skorlu odemeler 256.518 > b·H(r, prior) = 34.657
```

**Neden:** kirpma **teleskoplamayi bozuyor.** Bir agent'in buyuk kaybi kirpilinca,
karsi taraftaki buyuk kazanci dengeleyen para ortadan kalkiyor ve fark soru
sorana yikiliyor. `Sum_t S_CEM = S_CE(r,q^T) - S_CE(r,q^0)` esitligi artik
gecerli degil, dolayisiyla `b·log2` garantisi de yok.

Bu sessiz bir hata olurdu: market calisirdi, odemeler makul gorunurdu, ama soru
soranin maliyeti sinirsiz olurdu.

### Cozum: bond = kirpma esigi degil, POZISYON LIMITI

**PLAN.md Bolum 5.1 zaten dogruyu yaziyormus**, ben ADIM 9'da yanlis uyguladim.
Plan diyor ki: "Bond'u giris ucreti degil pozisyon limiti olarak kullan. Agent
q^(t)'yi bond'unun tasiyabilecegi kadar oynatabilsin."

Sorunu settlement'ta yamalamak yerine **rapor aninda engelliyoruz.**

Turetme: `S_CEM(r, q, qPrev) = Sum_i r_i log(q_i/qPrev_i)` ifadesi `r`'de
DOGRUSAL, dolayisiyla simpleks uzerindeki minimumu bir kosede:

```
worstCaseLoss = -b · min_i log(q_i / qPrev_i)
```

`worstCaseLoss <= bond` kosulundan, `c = e^(-bond/b)` ile izinli aralik:

```
q_1 >= qPrev_1 · c
q_1 <= 1 - (1 - qPrev_1) · c
```

Ornek: b=1, bond=1, qPrev=0.5 -> c=e^-1=0.368 -> q_1 in [0.184, 0.816].

### Uygulama

- `scoring.ts`: `worstCaseLoss`, `moveLimits`, `clipToAllowedMove` eklendi
- `market.ts`: `submitReport` iki asamali kirpiyor — once epsilon (log(0)
  saldirisi), sonra hamle limiti
- `settlement.ts`: kirpma TAMAMEN KALDIRILDI. Teminati asan kayip gelirse artik
  sessizce duzeltilmiyor, **hata firlatiliyor** — market hatali bir hamleye izin
  vermis demektir
- `types.ts`: `Payout.clippedBy` kaldirildi, artik kimse set etmiyor

Bond'un anlami boylece netlesti: **ne kadar teminat koyarsan konsensusu o kadar
oynatabilirsin.** Bu, mekanizma acisindan da dogru: fiyati cok oynatmak cok risk
almak demek.

### Ikinci bulgu: yanlis degismez

Testte "pozitif odemelerin toplami deposit'i asamaz" diye yazmistim. Yanlis:
pozitifler negatiflerle dengelendigi icin toplamlari deposit'i asabilir.

Dogru ve kanitlanabilir garanti: **askerRefund >= 0**.

```
askerRefund = deposit - pozitif + scoreSlash + timeoutSlash
            = b·log2 - netScored + timeoutSlash
netScored <= b·log2 (teleskoplama)  =>  askerRefund >= 0
```

Bunu teste degil, `assertSettlementInvariants` icine gercek bir degismez olarak
koydum.

### Dayatilan bes degismez

`assertSettlementInvariants` her settlement'ta calisiyor:

1. Skorlu odemeler `b·H(r, prior)` asmiyor (teleskoplama)
2. Sabit ucret alan sayisi tam olarak `min(k, n)`
3. Muhasebe kapaniyor: `deposit + totalBonds == totalToAgents + askerRefund`
4. `askerRefund >= 0` — soru soranin cebinden deposit'ten fazlasi cikmiyor
5. Hicbir kayip teminati asmiyor

3 numarali degismez 100 rastgele markette ve timeout'lu senaryoda dogrulandi.

### Dejenere durum ele alindi

Hic rapor gelmeden herkes timeout olursa `reference` undefined kaliyor.
Settlement bunu isliyor: odeme yok, timeout olanlarin teminati slash, hic
cekilmeyenlerin teminati iade, kalan her sey askere.

### ADIM 8'de guncellenen test

`submitReport` artik iki asamali kirptigi icin `0.5 -> 1.0` hamlesi epsilon'da
(0.99) degil hamle limitinde (0.816) duruyor. ADIM 8 testi buna gore
guncellendi, ayrica "bol teminatla epsilon baglayici olur" testi eklendi.

---

## ADIM 10 — k Hesaplayıcı (Teorem 1 ve Teorem 4)

- **Tarih:** 2026-09-10
- **Durum:** GEÇTİ
- **Test:** 64 yazıldı, 64 geçti
- **Tam suite:** 163/163 yeşil, build temiz
- **Kanıt:** `pnpm kcalc` çıktısı aşağıda özetli; `pnpm test` 163/163; `pnpm build` exit 0

### DİL DEĞİŞİMİ — bu adımdan itibaren

Kod, kod yorumları, hata mesajları ve CLI çıktısı bundan sonra **İngilizce**.
Planlama dokümanları (PLAN.md, ROADMAP.md, bu dosya) Türkçe kalıyor.

Gerekçe: repo ve CLI çıktısı submission'ın parçası, jüri okuyacak. ADIM 6-9'da
yazılan `packages/core` dosyaları hâlâ Türkçe yorumlu; tek seferde çevrilmesi
bekliyor (öneri: ADIM 32, README yazarken, çünkü o adımda zaten hepsi
okunacak).

### Yazılanlar

`packages/core/src/kcalc.ts`:

| Fonksiyon | Kaynak |
|---|---|
| `signalSpread(eta)` | `(1-η)/η - η/(1-η)`, üç formülün de ortak çarpanı |
| `deviationBound(delta, eta, k)` | Teorem 1, sapma sınırı |
| `kMinApprox(delta, eta, epsilonPrime)` | Teorem 1, Denklem 3 |
| `kMinStrict(delta, eta, tau)` | Teorem 4, Denklem 7 |
| `poolExhaustionProbability`, `flatFeeProbability` | `config.ts`'ten yeniden dışa aktarım |

`scripts/kcalc.ts` — dört tablo + karar bloğu basan CLI (`pnpm kcalc`).

### Doğrulama — PLAN'daki her sayı koddan çıkıyor

CLI çıktısı PLAN.md'deki üç tabloyla **birebir** eşleşiyor:

| Tablo | Kaynak | Durum |
|---|---|---|
| kMinApprox, ε=0.05 (12 hücre) | PLAN 2.3 | ✓ 4.2 / 5.5 / 6.6 … 27.8 / 36.0 / 43.2 |
| kMinStrict (9 hücre) | PLAN 2.3 | ✓ 4.7 / 6.7 / 9.3 … 16.0 / 19.9 / 25.0 |
| Havuz seçenek tablosu | PLAN 4.1 | ✓ %5.3 / %7.9 / %10.7 / %16.4 |
| Sapma sınırı k=3/4/6 | PLAN 4.3 | ✓ 0.278 / 0.139 / 0.035 |

ROADMAP'in istediği ±0.05 toleransı fazlasıyla sağlanıyor; sapmaların hepsi
0.04'ün altında ve bu yuvarlamadan geliyor (PLAN tabloları 1 ondalıklı).

### En değerli test: ters çevirme değişmezi

`deviationBound` ile `kMinApprox` paper'da **ayrı iki denklem** ve koda ayrı
ayrı geçirildi. Denklem 3, Teorem 1'in sınırının k için çözülmüş hali,
dolayısıyla ikisi birbirinin tam tersi olmak zorunda:

```
deviationBound(δ, η, kMinApprox(δ, η, ε)) === ε     (tolerans 1e-10)
```

Beş farklı parametre üçlüsünde geçiyor. Herhangi biri yanlış kopyalanmış olsa
bu tur anında kırmızı yanardı. Tabloları kendi kendine doğrulayan bir teste
göre çok daha güçlü bir kontrol.

Ayrıca `Math.ceil(kMinApprox(...))` her zaman hedefin **içine** düşüyor, yani
yukarı yuvarlama güvenli tarafta kalıyor.

### k=3 boşluğu artık bir test

README'deki iddia koda bağlandı, iddia ile kod sessizce ayrışamıyor:

```
Math.ceil(kMinApprox(0.5, 0.1, 0.05)) === 6      // sınırın istediği
DEFAULT_PARAMS.k === 3                            // koştuğumuz
deviationBound(0.5, 0.1, 3) ≈ 0.278               // bedeli
deviationBound(0.5, 0.1, 6) ≈ 0.035
```

### PLAN Bölüm 14 için not — ikinci bir sayı var

PLAN'ın dürüstlük beyanı sadece Teorem 1'in sayısını (k≈6) veriyor. CLI aynı
referans parametrelerde Teorem 4'ün (strict truthfulness, τ=1.0) **k > 8.24,
yani 9 agent** istediğini de basıyor. Bu sayı PLAN 2.3'teki tabloda zaten
vardı ama Bölüm 14'e taşınmamış.

Boşluk düşünülenden büyük. ADIM 32'de README yazılırken iki sınır da
verilmeli: Teorem 1 için 6, Teorem 4 için 9. Saklanacak bir şey değil, aksine
"iki farklı dürüstlük tanımının iki farklı fiyatı var" ayrımı anlatımı
güçlendiriyor.

---

## ADIM 11 — Simülasyon Harness'ı ve Üç Senaryo

- **Tarih:** 2026-09-10
- **Durum:** GEÇTİ
- **Test:** 28 yazıldı, 28 geçti (3'ü kırmızı başladı, ikisi gerçek hataydı)
- **Tam suite:** 191/191 yeşil, build temiz

### Yazılanlar

`packages/core/src/simulate.ts` — `simulateMarket`, `SimAgent`, üç senaryo
agent'ı (`makeHonestAgent`, `makeLiarAgent`, `makeLazyAgent`), `honestPool`,
`closingPrice`.

`packages/core/src/random.ts` — `SeededRandom` buraya taşındı.

### GERÇEK TASARIM HATASI BULUNDU: hareketsiz honest agent

Bu adımın en önemli çıktısı yine bir test kırmızısının arkasındaki hata.

İlk yazdığım honest agent kendi sinyalini `w = 1/(t+1)` ağırlığıyla piyasa
fiyatına karıştırıyordu. Naif Bayesçi hamle: geçmiş uzadıkça geçmişe daha
çok güven. Mantıklı görünüyor ve **her önceki raporun dürüst olduğunu
varsayıyor.**

Sonuç: geç turlarda `w` neredeyse sıfıra iniyor ve honest agent'lar fiyatı
oynatamaz hale geliyor. Tek bir yalancı fiyatı aşağı itiyor, arkasından gelen
kimse geri toplayamıyor, market yalanın yakınında kapanıyor.

**Ve yalancı bunun için ödül alıyor** — çünkü CE-MSR fiyatı referansa doğru
oynatana ödeme yapar, niyete bakmaz. Referans da yalanın yanına düşmüştür.

Ölçüm (60 seed, 19 dürüst + 1 yalancı):

| | `w = 1/(t+1)` | sabit `w = 0.4` |
|---|---|---|
| Yalancının pozitif ödeme aldığı koşu | **9 / 17** | **0 / 17** |
| Ortalama kapanış fiyatı (gerçek 0.75) | ~0.45 | ~0.75 |
| Market uzunluğu | 12-20 rapor | normal |

Karma senaryoda (10 dürüst + 5 yalancı + 5 tembel) hata daha da net:

| | `w = 1/(t+1)` | sabit `w = 0.4` |
|---|---|---|
| Dürüst ortalama | **-0.0051** | **+0.0119** |
| Yalancı ortalama | -0.0109 | -0.0423 |
| Tembel ortalama | 0.0000 | 0.0000 |

Yani eski agent modelinde **hiçbir şey yapmamak (tembel, tam 0) dürüst
davranmaktan daha kârlıydı.** ROADMAP'in ADIM 11 için istediği "dürüstlerin
ortalama ödemesi en yüksek" kriteri sağlanmıyordu.

**Çözüm:** sabit `selfWeight` (varsayılan 0.4). Her agent, kaçıncı sırada
çekilirse çekilsin fiyatı kendi inancına doğru sabit bir oranda çekebiliyor.
Market kendini düzeltebiliyor, yalan birkaç rapor içinde eriyor.

Bu karar `selfWeight` parametresi olarak açıkta duruyor ve **bir regresyon
testiyle korunuyor**: `selfWeight=0.05` ile yalancı hâlâ kâr edebiliyor,
`0.4` ile hiç edemiyor. Biri gelip agent'ı "iyileştirip" eski haline
döndürürse test kırmızı yanacak.

### İkinci bulgu: yalancı referans olursa yalan kazanıyor

Aynı koşuları kapanış fiyatını kimin belirlediğine göre ayırdım. Bu ROADMAP'te
istenmiyordu, veriye bakarken çıktı:

| Referansı belirleyen | Koşu | Dürüst ort. | Yalancı ort. |
|---|---|---|---|
| dürüst agent | 34 | +0.0381 | -0.0904 |
| **yalancı agent** | **18** | **-0.0478** | **+0.0549** |
| tembel agent | 8 | +0.0307 | -0.0592 |

Mekanizma herkesi terminal agent'ın raporuna göre skorluyor. Terminal agent
yalancıysa market yalana çözülüyor ve yalanla savaşan dürüstler ödüyor.

Bu bir hata değil, **k=3'ün ampirik yüzü.** Teorem 1'in sınırladığı şey tam
olarak bu ve k=3'te sınır 0.278, yani teorik değil gözle görülür seviyede.
Genel sonucu bozmuyor (dürüst ortalamada hâlâ kazanıyor) ama ADIM 32'de
README'ye k sayısının yanına konmalı: boşluğun somut karşılığı bu tablo.

Test olarak sabitlendi.

### Senaryo 3 — tam sıfır (paper Teorem 7)

Videodaki en güçlü an, matematiksel karşılığıyla yeşil.

Herkes bir öncekini kopyalarsa `scoreCEM(r, q, q) = Σ r_i log(1) = 0`.
`Math.log(1)` IEEE754'te **birebir 0**, dolayısıyla bu 1e-10 toleransı
değil, tam eşitlik. 60 seed × onlarca skorlanan agent, hepsi tam sıfır.

İlk agent `KL(r || prior)` alıyor, o da tam. İki varyant da test edildi:
- `whenFirst` verilirse (0.7): ilk agent `KL` alıyor, geri kalan herkes 0
- `whenFirst` verilmezse ilk agent prior'ı raporluyor: `KL(prior||prior)=0`,
  **bütün market tam sıfır ödüyor**

ROADMAP ikincisini tarif ediyordu ("ilk agent prior'ı raporlar") ama o
dejenere durum; paper'ın Teorem 7'si asıl birincisi. İkisi de duruyor.

### Testler neden tek seed'e değil seed taramasına dayanıyor

Çekiliş sırası ve durma turu rastgele. "Yalancı para kaybetti" tek seed'de
doğrulanamaz: bazı seed'lerde yalancı sabit ücret kuyruğuna düşüyor ve hiç
skorlanmıyor — doğru sonuç ama test edilen şey o değil.

Bu yüzden senaryo testleri 60 seed tarıyor ve iddianın gerçekten sınandığı
koşular üzerinden özellik doğruluyor. Ayrıca her testte "kaç koşuda sınandı"
sayacı var (`expect(scoredRuns).toBeGreaterThan(10)`) — iddia hiç
sınanmadan yeşil yanamıyor. ADIM 7 ve 9'daki 100 rastgele market disiplininin
aynısı.

### Benim test hatam (kod değil test yanlıştı)

Scenario 2'nin "slash edilen para askere döner" testinde pozitif ödemeleri
bir tarafta sadece skorlu agent'lar üzerinden, diğer tarafta sabit ücretler
dahil toplamışım. Kıyas baştan tutarsızdı ve testin talep ettiği şey aslında
`scoreSlash > k·R` idi — kastedilen bu değildi.

Kod doğruydu. Testi doğru kurala göre yeniden yazdım: askerin iadesi slash
edilen parayı **tam olarak** taşımalı ve agent'lara giden toplam sadece
`bondsReturned + scoreTotal` olmalı. Böylece ileride biri slash'i agent'lara
dağıtmaya kalkarsa test kırılıyor.

### ROADMAP'ten sapmalar

**1. `SeededRandom` `test/helpers.ts`'ten `src/random.ts`'e taşındı.**
`simulateMarket` seed alan üretim kodu ve aynı PRNG'ye ihtiyaç duyuyor.
mulberry32'yi iki yerde tutmak, testin test ettiği şeyle ayrışması demekti.
`test/helpers.ts` yeniden dışa aktarıyor, mevcut import'lar ve ADIM 1
testleri değişmedi. `ScriptedRandom` ve `LabelledRandom` test tarafında kaldı.

**2. `simulateMarket` beşinci bir `opts` parametresi aldı** (`id`, `question`,
`deposit`). ROADMAP imzası dört parametre; hepsinin varsayılanı var, imza
geriye uyumlu. Gerekçe: ADIM 31 demo senaryolarını isimlendirecek, ayrıca
settlement'ın `deposit` seçeneği test edilebilir olmalı.

**3. `makeHonestAgent` `selfWeight` parametresi aldı.** ROADMAP "basit
ağırlıklı ortalama yeterli" diyordu; hangi ağırlık olduğu ölçülerek seçildi
ve yukarıdaki hatanın sebebi tam olarak bu parametreydi. Açıkta duruyor ki
karar görünür olsun.

### Kalan risk

Mekanizma tarafında yok. Dört senaryo da `DEFAULT_PARAMS` üzerinde koşuyor —
daha kolay bir ayarla değil, gönderdiğimiz konfigürasyonla.

Proje tarafında **ADIM 4 (SPIKE C, ENSv2 Sepolia) hâlâ açık, ADIM 5 spike
kapısı hiç çalıştırılmadı.** FAZ 1 bitti, sıradaki adım ADIM 12 ile FAZ 2
(Hedera). ENS spike'ı artık gerçekten gecikti.

**Kullanıcı kararı (2026-09-10):** ENS spike'ı beklemeye alındı, FAZ 2'ye
devam. Sıkıntı çıkarsa ENS track'i tamamen düşürülecek. PLAN Bölüm 11 zaten
ENS'i "kesilebilir tek parça" olarak konumlandırıyordu.

---

## ADIM 12 — Hedera Hesap Altyapısı

- **Tarih:** 2026-09-10
- **Durum:** GEÇTİ
- **Test:** 47 yazıldı, 47 geçti (14 env + 12 retry + 21 accounts-file)
- **Tam suite:** 238/238 yeşil, build temiz
- **Kanıt:** `pnpm check:accounts` çıktısı — 21 hesap zincirden okundu, hepsi doğru bakiyede

### Zincir üstü sonuç

| | |
|---|---|
| Treasury | `0.0.10455276` (100 HBAR) |
| Agent'lar | `0.0.10455278` – `0.0.10455301`, 20 adet, her biri 10 HBAR |
| Havuzda kilitli | 300 HBAR |
| Operatör | 998.2046 → 684.5828 HBAR |
| Gerçek maliyet | 313.62 HBAR (300 fonlama + 13.62 ücret, hesap başı ~0.65) |

HashScan: https://hashscan.io/testnet/account/0.0.10455276

Tahmin 310.5 HBAR'dı, gerçek 313.62. Hesap başına ayrılan 0.5 HBAR ücret payı
biraz düşükmüş ama emniyet marjı olarak iş gördü.

### Yazılanlar

`packages/hedera/src/` — `env.ts`, `retry.ts`, `client.ts`, `accounts.ts`,
`accounts-file.ts`.

`scripts/` — `setup-hedera-accounts.ts`, `check-accounts.ts`, `load-env.ts`.

### Para taşıyan kodun iki savunması

**1. Retry beyaz listesi.** Tehlikeli senaryo "çağrı başarısız oldu" değil,
**"çağrı zaman aşımına uğradı ve gerçekleşip gerçekleşmediğini bilmiyoruz."**
O durumda transfer'i körlemesine tekrarlamak iki kez ödeme yapar.

Sadece ağın isteği kesinlikle işlemediği durumlar tekrarlanıyor: `BUSY`,
`PLATFORM_NOT_ACTIVE`, `PLATFORM_TRANSACTION_NOT_CREATED`, ve transport
hataları. `INSUFFICIENT_PAYER_BALANCE` veya `INVALID_SIGNATURE` sonsuza kadar
aynı şekilde başarısız olur, tekrarlamak sadece ücret yakar ve asıl hatayı
gizler.

**`DUPLICATE_TRANSACTION` özellikle tekrarlanmıyor** — o zaten "ilk deneme
tuttu" demek.

**Tanınmayan hata kalıcı sayılıyor.** Beyaz liste olması bilinçli: yanlışlıkla
ödeme tekrarlamanın maliyeti, kurtarılabilir bir hatayı yüzeye çıkarmanın
maliyetinden çok yüksek.

**2. Donmuş işlem = aynı transaction id.** İşlem ilk denemeden önce
`freezeWith` ile donduruluyor, retry aynı id'yi taşıyor. İlk deneme aslında
zincire yazılmışsa retry `DUPLICATE_TRANSACTION` alıyor, ikinci kez para
göndermiyor. Retry'ı "kullanışlı" olmaktan çıkarıp "güvenli" yapan şey bu.

### Script'in üç operasyonel özelliği

**Idempotent.** `agents/accounts.json` okunuyor ve sadece eksik olan
oluşturuluyor. Doğrulandı: ikinci koşu "0 agents, ~0.00 HBAR" dedi ve client
bile açmadı.

**Her hesaptan sonra dosyaya yazıyor**, sonda bir kez değil. Anahtarı
kaydedilemeyen bir hesap, geri alınamaz şekilde kaybedilmiş HBAR demek.
19. agent'ta çöken bir koşu ilk 18'in anahtarını götürmemeli.

**`--dry-run`.** Zincire dokunmadan planı ve maliyeti basıyor. Gerçek koşudan
önce bununla kontrol edildi.

Ayrıca ön kontrol var: operatör bakiyesi yetmiyorsa hiç başlamıyor.

### ROADMAP'ten sapmalar

**1. `accounts.json` düz dizi değil, nesne.** ROADMAP `[{agentId, accountId,
privateKey}]` gösteriyordu. `version` ve `network` alanları eklendi.

Gerekçe: hesap id'leri ağlar arasında taşınabilir değil. `0.0.1234` hem
testnet'te hem mainnet'te var ve bambaşka hesaplar. Ağ alanı olmayan bir
defter yanlış ağa doğrultulduğunda **bir yabancıyı fonlar.**
`assertNetworkMatches` her yüklemede bunu kontrol ediyor.

**2. `AGENT_COUNT` küçültülürse hesap SİLİNMİYOR.** `missingAgentIds` sadece
eksiği söylüyor, fazlayı bildirmiyor. Bir env değişkeni değişti diye anahtar
malzemesi imha etmek kötü bir sürpriz olurdu; kullanılmayan hesabın maliyeti
sıfır, atılmış özel anahtar geri gelmiyor.

**3. `retry.ts` `client.ts`'ten ayrıldı.** İlk halinde retry mantığı
client.ts içindeydi ve testler oradan import ediyordu, bu da her koşuda
`@hashgraph/sdk`'yı yüklüyordu: **`pnpm test` 1.3 sn'den 16.8 sn'ye çıktı.**

ROADMAP test protokolü açıkça "tam suite her adımda çalışacak, saniyeler
içinde bitmeli" diyor. Retry politikası SDK'ya hiç ihtiyaç duymuyor, ayrı
modüle alındı ve testler barrel yerine doğrudan modülü import ediyor.
Süre 2.25 sn'ye döndü.

**4. `scripts/check-accounts.ts` eklendi** (ROADMAP'te yok). Kabul kriteri
"her hesabın bakiyesi HashScan'de görülebiliyor" idi; tek tek explorer açmak
yerine 21 hesabı zincirden okuyup defterle karşılaştıran tekrarlanabilir bir
kapı yazdım. Demo öncesi "havuz hâlâ ödeme yapabilir mi" kontrolü olarak da
kalıcı değeri var.

**5. `scripts/load-env.ts`.** dotenv tuzağı SPIKE A'da bir kez çözülmüştü ama
spike'ın içinde kalmıştı. Artık paylaşılan. ADIM 15, 16 ve 21 script'leri de
bunu kullanacak.

### Tuzaklar

**`setKey` SDK 2.81'de deprecated.** `setKeyWithoutAlias(publicKey)`
kullanıldı. Alternatifleri de var (`setKeyWithAlias`, `setECDSAKeyWithAlias`)
ama EVM alias'ına şu an ihtiyaç yok; x402 Hedera signer'ı hesap id + anahtar
ile çalışıyor (SPIKE A'da doğrulanmıştı). `evmAddress` yine de public
key'den türetilip deftere yazılıyor, ileride lazım olursa duruyor.

**Scratchpad'ten workspace paketi import edilemiyor.** Doğrulama script'ini
önce geçici klasöre yazdım, `@ethonline/hedera` çözülemedi
(`MODULE_NOT_FOUND`) çünkü klasör repo ağacının dışında. Zaten kalıcı olması
daha doğruydu, `scripts/check-accounts.ts` oldu.

**Anahtar tipi ECDSA.** Operatörle aynı. Ön uçuş kontrolünde `fromString`'in
ECDSA/ED25519 ayrımında sessizce yanlış tahmin edebildiği görülmüştü; her
yerde açıkça `fromStringECDSA` kullanılıyor.

### Kalan risk

`agents/accounts.json` 20 özel anahtar taşıyor ve gitignore'da olduğu
doğrulandı (`git check-ignore` ve `git status` ile). Dosya kaybolursa 300
HBAR geri alınamaz. Testnet olduğu için kritik değil ama ADIM 21'de agent'lar
bu anahtarlarla imza atacak, dosya yedeklenmeli.

ADIM 4 (ENS spike) hâlâ açık, kullanıcı kararıyla ertelendi.

---

## ADIM 13 — HCS Rapor Defteri

- **Tarih:** 2026-09-10
- **Durum:** GEÇTİ
- **Test:** 27 yazıldı, 27 geçti (17 mesaj şeması + 10 mirror okuma)
- **Tam suite:** 265/265 yeşil, build temiz
- **Kanıt:** `pnpm check:hcs` — testnet'te 13 kontrol, hepsi PASS

### Zincir üstü sonuç

Topic `0.0.10455618`, https://hashscan.io/testnet/topic/0.0.10455618

```
#1  market-open    210 bytes  hash be17be6a36213cb8...
#2  report         152 bytes  hash 22d2e293793bef94...
#3  report         154 bytes  hash 98ef2a435a79cda3...
#4  market-close   146 bytes  hash 86b957c6091310e5...
```

**En kritik sonuç: receipt'ten gelen running hash'ler mirror node'dan okunanla
birebir aynı.** ADIM 14 durma zarını bu değerden türetecek. Eşleşmeseydi
"rastgelelik doğrulanabilir" iddiası çökerdi; artık bizim beyanımız değil,
üçüncü tarafın okuyabildiği bir veri.

Dört hash de birbirinden farklı, yani her rapor taze entropi üretiyor.

### Topic anahtar politikası — preflight'ta ertelenen karar

ADIM 2 öncesi kontrolde topic silinememişti ve karar ADIM 13'e bırakılmıştı.
Karar:

**Admin key YOK.** Admin key verilmeden oluşturulan topic hiçbir zaman
güncellenemiyor ve silinemiyor — bizim tarafımızdan da. Denetim izi iddiasının
tamamı bu: rapor defteri "sözleşmeyle" değil, **yapı gereği** kalıcı. Bedeli
test topic'lerinin testnet'te sonsuza kadar birikmesi, ödemeye değer.

**Submit key VAR**, operatöre ayarlı. Olmasaydı isteyen herkes deftere sahte
bir `report` mesajı ekleyebilirdi ve kayıt hiçbir şey ifade etmezdi. Submit
key sadece **kimin yazacağını** kontrol ediyor; yazılmış olanı değiştirme veya
silme yetkisi vermiyor ve okuma herkese açık kalıyor. Yani: append-only, yazarı
belli, herkesçe doğrulanabilir.

Admin key olmadığı için submit key topic'in ömrü boyunca sabit, döndürülemez.
Marketler kısa ömürlü ve her biri kendi topic'ini alıyor, kabul edilebilir.

### BİR MESAJ = BİR SEQUENCE = BİR RUNNING HASH

Bu adımın en önemli tasarım kısıtı ve ADIM 14 buna dayanıyor.

SDK, chunk boyutunu aşan bir mesajı **sessizce** birden fazla işleme bölüyor
ve her parça kendi sequence number'ını ve running hash'ini alıyor. Sessizce
ikiye bölünmüş bir rapor iki hash üretirdi ve "marketi hangi hash kapattı"
sorusunun tek bir cevabı olmazdı.

İki savunma:
- `assertFitsSingleMessage` gönderimden önce 1024 byte sınırını kontrol ediyor
- `setMaxChunks(1)` ile SDK bölmek yerine hata veriyor

Aşan mesaj sessizce bölünmüyor, **gürültülü şekilde başarısız oluyor.**

Testte en kötü gerçekçi durum ölçüldü: 20 raporluk bir marketin settlement
mesajı, 20 ödeme satırıyla, tek mesaja sığıyor. Sığması için payout'lar tuple
olarak kodlanıyor: `[agentId, position, "s"|"f", amount]`.

### Kanonik kodlama

Alanlar mesaj tipine göre sabit sırada yazılıyor, nesne anahtar sırası ne
olursa olsun aynı byte'lar çıkıyor. Gerekçe: mesaj üzerinden alınan bir
digest'in anlamlı olması için kodlamanın tekrarlanabilir olması şart
(`evidenceDigest`, ADIM 20).

Tanımsız opsiyonel alanlar `null` yazılmıyor, düşürülüyor — "yok" ile
"boş" aynı byte'ları üretiyor.

### ROADMAP'ten sapmalar

**1. Okuma tarafı `hcs-read.ts` olarak ayrıldı ve `@hashgraph/sdk` import
etmiyor.**

Bu bir optimizasyon değil, iddianın kendisi: "herkes marketi kendi kontrol
edebilir" demek, doğrulamanın **yazarın araç zincirini gerektirmemesi**
demek. Tarayıcı ve `fetch` yeterli. Doğrulama SDK isteseydi iddia çok daha
zayıf olurdu.

Yan faydası testleri hızlı tutması: barrel üzerinden import edilince suite
2.26 → 3.11 sn'ye çıkmıştı, ayrıldıktan sonra 2.5 sn.

**2. Okuma mirror node REST üzerinden, `TopicMessageQuery` ile değil.**
ROADMAP `readTopicMessages(topicId)` diyordu, imza `(network, topicId, opts)`
oldu. `TopicMessageQuery` uzun ömürlü bir gRPC aboneliği; "hepsini oku ve
döndür" için REST hem daha uygun hem de yukarıdaki SDK'sız doğrulanabilirlik
argümanını mümkün kılan şey.

**3. `submitMessage` receipt yerine record çekiyor.** Consensus timestamp
sadece record'da var, receipt'te yok. Mesaj başına bir ekstra ücretli sorgu
maliyeti var; değer, çünkü sıralama iddiasını bize güvenmeyen birinin
kontrol edebilmesini sağlayan alan tam olarak o.

**4. `scripts/check-hcs.ts` eklendi** (ROADMAP'te yok), ADIM 12'deki
`check-accounts.ts` ile aynı gerekçe: kabul kriteri "HashScan'de görünüyor"
idi, tekrarlanabilir bir kapı daha iyi kanıt.

**5. Parse edilemeyen mesaj atılmıyor, hatasıyla birlikte döndürülüyor.**
Topic herkese açık veri. Submit key bir gün olmasa içinde her şey olabilir;
okuyucunun işi orada ne varsa aynen bildirmek, sessizce filtrelemek değil.

### Tuzaklar

**Build kapısı yine testlerin görmediğini yakaladı.** `vi.fn(async () => ...)`
parametresiz yazılınca mock'un `mock.calls` tipi boş tuple oluyor ve
`calls[0][0]` derlenmiyor; ayrıca imza `fetch`'in `(input: string | URL |
Request)` tipiyle uyuşmuyordu. vitest tipleri esbuild ile soyduğu için testler
yeşildi. ADIM 8'in dersi üçüncü kez doğrulandı: `pnpm test` tek başına
yeterli değil.

**Mirror node gecikmesi.** Mesajlar consensus'tan birkaç saniye sonra
görünüyor. Kontrol script'i 2.5 sn aralıklarla 12 deneme yapıyor; pratikte
ilk denemede geldi. ADIM 16'da orchestrator bunu hesaba katmalı — settlement
mirror'dan okumaya bağlıysa bekleme gerekir. Running hash receipt'ten
geldiği için durma zarı bu gecikmeden etkilenmiyor.

### Kalan risk

Mesaj boyutu şu an rahat (146-210 byte, sınır 1024). ADIM 20'de raporlara
`evidenceDigest` eklenecek (~75 byte), yine sorun yok. Ama ADIM 19'da veri
dilimi özetleri mesaja girerse sınır zorlanır — özetler HCS'e değil, digest'i
HCS'e yazılacak şekilde tasarlanmalı.

ADIM 4 (ENS spike) hâlâ açık.

---

## ADIM 14 — HCS Running Hash'ten Rastgelelik

- **Tarih:** 2026-09-10
- **Durum:** GEÇTİ
- **Test:** 24 yazıldı, 24 geçti
- **Tam suite:** 289/289 yeşil, build temiz
- **Kanıt:** `pnpm check:randomness` — testnet'te gerçek market, 11 kontrol PASS

### Zincir üstü sonuç

İki koşu yapıldı. İlki ilk turda kapandı (u=0.073 < α=0.125, meşru ama %12.5'lik
durum ve çok turlu yolu sınamıyor). İkincisi:

```
Topic 0.0.10455778
# 1  agent-01  p=0.572  u=0.170055  continue
# 2  agent-11  p=0.615  u=0.604411  continue
# 3  agent-02  p=0.669  u=0.953652  continue
# 4  agent-14  p=0.577  u=0.758507  continue
# 5  agent-13  p=0.674  u=0.635815  continue
# 6  agent-20  p=0.649  u=0.325732  continue
# 7  agent-10  p=0.633  u=0.565451  continue
# 8  agent-19  p=0.696  u=0.072982  CLOSE
```

**8 rapor — beklenen market uzunluğunun tam kendisi** (E = 1/α = 8). 8 zar,
8 çekiliş, aynı agent iki kez çekilmedi, hiçbir durma değeri çekiliş değeri
olarak tekrar kullanılmadı.

En önemlisi: bütün kararlar **sadece mirror node verisiyle** yeniden türetildi
ve uydurma bir iddianın yakalandığı gösterildi.

### İKİ GERÇEK HATA ÖNLENDİ

Bu adımın asıl değeri iki incelikte. İkisi de sessiz kalsa çalışıyor görünen
ama bozuk bir market üretirdi.

**1. `[0,1)` aralığı gerçekten kapalı değildi.**

ROADMAP "ilk 8 byte'ı uint64 alıp 2^64'e böl" diyor. Doğru görünüyor ve değil:

```js
Number(2n ** 64n - 1n) / 2 ** 64  // === 1  (tam olarak 1.0)
```

`Number(2^64-1)` çift duyarlıkta **yukarı yuvarlanıp** 2^64 oluyor ve bölme
tam 1.0 veriyor. Aralık artık yarı açık değil. Bir 1.0, `floor(u * poolSize)`
ifadesini havuzun bir ötesine taşırdı.

Çözüm: en üstteki 53 biti al (`value >> 11n`), 2^53'e böl. Bu bir double'ın
tam olarak tutabildiği genişlik; en büyük sonuç `(2^53-1)/2^53`, yuvarlama
olmadan 1'in altında. Preflight'ın hesabıyla 2^-53 farkla aynı değeri veriyor,
yani ROADMAP'in niyeti korunuyor.

Test hem `hashToUnitInterval(0xff...)` < 1 olduğunu hem de naif formülün
tam 1.0 verdiğini kayda geçiriyor.

**2. Durma zarı ile agent çekilişi aynı byte'ları okuyamaz.**

Bir tur rastgeleliği iki kez tüketiyor: rapor N yazıldıktan sonra durma zarı,
market devam ederse agent N+1'in çekilişi. İkisi de doğal olarak en yeni
running hash'e uzanır.

**Aynı byte'ları okurlarsa çekiliş zehirlenir.** Çekilişe ulaşmış olmak, durma
zarının tutmadığı anlamına gelir, yani `u >= alpha`. Aynı `u`'yu
`floor(u * poolSize)` içine vermek havuzun ilk `alpha` kesirini **sonsuza
kadar erişilemez** yapar. α=1/8 ile ilk %12.5'lik agent dilimi hiç çekilemez.

Çözüm: her amaç hash'in farklı bir 8 byte'lık penceresini okuyor. `stop`
byte 0-7 (ROADMAP'in kuralı aynen korunuyor), `draw` byte 8-15. Hash SHA-384
çıktısı, ayrık pencereler bu amaç için bağımsız.

**Neden ikinci bir hash turu değil de byte penceresi:** doğrulamanın tarayıcıda,
kripto kütüphanesi olmadan yapılabilmesi için. Aynı gerekçe `hcs-read.ts`'in
SDK'sız olmasıyla aynı.

Test bu yanlılığı doğrudan ölçüyor: 3000 hash'te, durma zarını atlatan
koşuların %8-17'sinde çekiliş değeri α'nın altında kalıyor. Byte'lar
paylaşılsaydı bu oran tam sıfır olurdu.

### Grinding — ROADMAP'in istediğinden daha güçlü bir ifade

ROADMAP "agent teorik olarak mesaj içeriğini değiştirerek hash'i grind
edebilir, ama consensus timestamp içerdiği için pratikte zor" demeyi
öneriyordu. Durum bundan daha iyi:

1. Agent HCS'e yazmıyor, orchestrator yazıyor. Agent sadece bir olasılık
   gönderiyor.
2. Running hash, **ağın consensus anında atadığı** timestamp'i içeriyor.
   Gönderen bunu seçemiyor, öngöremiyor.

Yani grinding "zor" değil, mesajı göndermeden önce hash'i hesaplamak mümkün
değil. README'de bu şekilde yazılmalı. Yine de production için VRF/drand
önerisi duruyor (PLAN Bölüm 16).

### `HcsRandomSource` hiçbir zaman `Math.random`'a düşmüyor

Hash gelmeden `next()` çağrılırsa hata fırlatıyor. Sessizce yerel bir
üretece düşmek, doğrulanabilir bir marketle doğrulanamaz bir marketi
birbirinden ayırt edilemez hale getirirdi. Test bunu kontrol ediyor.

Ayrıca her değer `draws` dizisine (etiket, amaç, hash hex, değer) kaydediliyor;
tek başına bu kayıttan bütün koşu yeniden hesaplanabiliyor.

### ROADMAP'ten sapmalar

**1. `hashToUnitInterval(hash)` ikinci bir `purpose` parametresi aldı.**
Varsayılanı `'stop'`, yani ROADMAP'teki çağrı imzası ve davranışı aynen
çalışıyor. Gerekçe yukarıda (2).

**2. `shouldStop` ayrıca dışa açıldı.** ROADMAP sadece
`verifyStoppingDecision` istiyordu ama karar kuralının kendisi de tek satır
ve dışarıdan çağrılabilir olmalı — orchestrator (ADIM 16) ve doğrulayan
üçüncü taraf aynı fonksiyonu kullanıyor, iki ayrı uygulama olmuyor.

**3. `scripts/check-randomness.ts` eklendi.** Hash aritmetiğini birim testler
zaten kapsıyordu; bu script `HcsRandomSource`'u `core`'daki gerçek `Market`
sınıfına takıp marketi consensus'a kapattırıyor. Aynı zamanda ADIM 16
orchestrator döngüsünün küçük bir provası — arayüzler birbirine oturmuyorsa
6. günde değil şimdi öğreniyoruz. Oturdu.

### Benim test hatam (kod değil test yanlıştı)

"Preflight'ın 0.689840 değerini yeniden üretiyor" diye bir test yazdım ve
hex byte'ları **uydurdum**. Uydurduğum `b0a4d1f2c3b4a596` gerçekte 0.690015
veriyor. Preflight'ın orijinal hash'i elimde olmadığı için o sayı yeniden
üretilemez; test baştan temelsizdi.

Kendi sabitine karşı kendini doğrulayan bir test zaten değersizdi. Elle
kontrol edilebilir sabitlerle değiştirdim: `8000...` → tam 0.5, `4000...` →
0.25, `c000...` → 0.75, ve son byte'taki 1 → 1e-15'ten küçük (big-endian
olduğunu kanıtlıyor). Bunlar aritmetiği bağımsız olarak sabitliyor.

### Kalan risk

Mekanizma tarafında yok. ADIM 16'da dikkat edilecek tek şey sıra:
**durma zarı, raporun HCS'e yazılmasından SONRA atılmalı**, çünkü rastgelelik
o raporun hash'inden geliyor. check-randomness.ts bu sırayı doğru kuruyor ve
orchestrator'a örnek teşkil ediyor.

ADIM 4 (ENS spike) hâlâ açık.

### ROADMAP'ten sapmalar

**1. `poolExhaustionProbability` ve `flatFeeProbability` kopyalanmadı.**
ROADMAP ikisini de `kcalc.ts` imzasında listeliyor, ama ADIM 6'da zaten
`config.ts`'e yazılmışlardı ve parametre doğrulaması onları kullanıyor.
Yeniden yazmak iki gerçek kaynak üretirdi. `kcalc.ts` bunları `config.ts`'ten
yeniden dışa aktarıyor: ROADMAP'in istediği yüzey duruyor, tek kaynak korunuyor.

**2. Kök `build` scripti artık `scripts/` klasörünü de tip kontrolünden
geçiriyor.** `tsconfig.scripts.json` eklendi, kök `build` = `pnpm -r build &&
tsc -p tsconfig.scripts.json`.

Gerekçe: `scripts/kcalc.ts` README'ye girecek submission kodu ama hiçbir
workspace paketinin tsconfig'inde değildi, yani hiç tip kontrolü görmüyordu.
`scripts/check-hedera.ts` de aynı durumdaydı. ADIM 8'in dersi tam buydu:
testler yeşilken build kırmızıydı ve gerçek bir imza hatası yakalanmıştı.
`pnpm -r build` tek başına yeterli değil çünkü `-r` kök paketi kapsamıyor.

`pnpm -r build` hâlâ çalışıyor ve değişmedi; kapı komutu `pnpm build` olarak
kullanılmalı. İkisi de şu an yeşil, mevcut `check-hedera.ts`'te tip hatası
çıkmadı.

**3. `@ethonline/core` kök `package.json`'a bağımlılık olarak eklendi**
(`workspace:*`). Böylece `scripts/*` paketi ismiyle import edebiliyor, göreli
yola gerek kalmıyor. ADIM 12 (`setup-hedera-accounts.ts`) ve ADIM 21
(`register-agents.ts`) aynı ihtiyacı duyacak.

### Tuzaklar

Bu adımda kırmızı test çıkmadı, düzeltilecek bir şey de olmadı. Formüller
PLAN Bölüm 2.3'te zaten elle hesaplanmış ve tablolanmıştı; kod onları
üretti, tersini değil.

Tek küçük engel araç tarafında: büyük dosyayı bash heredoc ile yazmak
başarısız oldu (`unexpected EOF`), dosya hiç oluşmadı. Doğrudan dosya yazma
aracına geçildi. Kaydediliyor çünkü sonraki adımlarda daha büyük dosyalar var.

### Kalan risk

Mekanizma tarafında yok — bu adım saf hesap, mekanizmaya dokunmuyor.

Proje tarafında **ADIM 4 (SPIKE C, ENSv2 Sepolia) hâlâ açık** ve ADIM 5
(spike kapısı) hiç çalıştırılmadı. ADIM 3'ün kaydındaki uyarı geçerliliğini
koruyor: ENS'te Sepolia adresleri dokümanda yok ve "admin rolleri sadece
registration anında" kısıtı deneyerek doğrulanmalı. FAZ 2'ye (Hedera)
girmeden önce bir oturum ayrılmalı; kesme kararı 12. güne bırakılmamalı.
