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

---

## ADIM 15 — x402 ile Korunan API Endpointleri

- **Tarih:** 2026-09-10
- **Durum:** GEÇTİ
- **Test:** 55 yazıldı, 55 geçti (11 pricing + 14 signature + 30 route)
- **Tam suite:** 344/344 yeşil, build temiz, 2.2 sn
- **Kanıt:** `pnpm check:api` — testnet'te gerçek ödeme, 14 kontrol PASS

### Zincir üstü sonuç

```
Market:   mkt-2026-09-10-001  (topic 0.0.10457425)
Deposit:  0.99314719 HBAR  = b·log2 + k·R, tam olarak
Bond:     1.00000000 HBAR  (agent-01 kendi hesabından ödedi)
Hazine:   +1.99314719 HBAR — beklenenle birebir
```

Ödemesiz istek 402, ödemeli istek 201, para gerçekten taşındı ve tutar
mekanizmanın hesapladığı sınırla birebir eşleşti.

### DÖRDÜNCÜ TUZAK — 402 challenge gövdede değil

SPIKE A üç tuzak kaydetmişti. Dördüncüsü burada çıktı:

**402 yanıtının gövdesi boş `{}`. Ödeme gereksinimleri `payment-required`
header'ında, base64 kodlanmış JSON olarak geliyor.**

Gövdeyi okuyunca doğru fiyatlandırılmış bir 402 boş görünüyor. Önce buna
takıldım: fiyat doğruydu, ödeme çalışıyordu, sadece kontrolüm yanlış yere
bakıyordu.

`@x402/core` bunun için decode helper'ı **vermiyor** (sadece
`decodePaymentResponseHeader` var, o da yanıt tarafı için). Elle çözülüyor:

```ts
JSON.parse(Buffer.from(res.headers.get('payment-required')!, 'base64').toString('utf-8'))
```

ADIM 20'de agent'lar Graph'a ödeme yaparken ve ADIM 22'de servis tüketicisi
yazılırken tekrar lazım olacak.

### GERÇEK KOD ZAYIFLIĞI: sessiz hex kesme

İmza doğrulamada `Buffer.from(str, 'hex')` kullanıyordum. Node bu fonksiyonda
**geçersiz karakterde hata vermiyor, ilk geçersiz karakterde durup okuduğu
kadarını döndürüyor:**

```
Buffer.from('abZZ','hex')   ->  1 byte
Buffer.from('nothex','hex') ->  0 byte
```

Bozuk bir imza "kısa ama düzgün" bir imza gibi doğrulamaya giriyor ve hata
mesajı "imza raporla eşleşmiyor" oluyor. Aynı görünen sonuç, tamamen farklı
sebep — agent yazan biri için yanlış teşhis.

Hex karakterleri artık elle doğrulanıyor. Regresyon testi
`Buffer.from('abZZ','hex').length === 1` olduğunu da kayda geçiriyor ki neden
elle kontrol ettiğimiz belgeli kalsın.

### İmza neyi bağlıyor

Rapor gönderimi **ücretsiz** olan tek yazma işlemi, dolayısıyla kimliği ödeme
kanıtlayamaz. İmza olmasa herkes herhangi bir agent adına rapor gönderebilirdi
ve herkes terminal rapora göre skorlandığı için bu settlement'ı sahtelemek
demek.

İmzalanan mesaj: `ethonline-report|v1|<marketId>|<agentId>|<position>|<p1>`

| Alan | Olmasaydı |
|---|---|
| marketId | bir marketin imzası başka markete replay edilir |
| agentId | imza başka agent'a atfedilir |
| position | rapor başka sırada replay edilir, farklı önceki fiyata karşı skorlanır |
| p1 | yükün kendisi |

Dördü de ayrı replay testine bağlı.

`p1` `toFixed(12)` ile yazılıyor: JSON anahtar sırası ve sayı biçimlendirmesi
çalışma zamanları arasında değişiyor, tekrar üretilemeyen byte'lar üzerindeki
imza hiçbir şey imzalamıyor demek.

**İmza ham olasılık üzerinden**, kırpmadan önce. Agent'ın taahhüt ettiği o ve
kırpmanın bağımsız denetlenebilir kalması gerekiyor.

### İki enjeksiyon noktası — testlerin var olma sebebi

**`paymentGate` enjekte ediliyor.** `createApp` facilitator'a hiç dokunmuyor.
Bütün route yüzeyi ağa çıkmadan test edilebiliyor (30 test), gerçek x402 akışı
ayrı kapıda doğrulanıyor. Gate'i `createApp` içinde kurmak her endpoint'i
6. güne kadar test edilemez bırakırdı.

**`Ledger` arayüzü enjekte ediliyor.** Her endpoint HCS'e yazıyor; bu dikiş
olmadan tek bir route bile `pnpm test` kapsamına giremezdi. ADIM 16
orchestrator'ı aynı dikişe ihtiyaç duyacak: turları sahte ledger'a karşı
koşturabilmek, mekanizmayı ayıklamakla ağı ayıklamak arasındaki fark.

Üretim implementasyonu bilinçli olarak çok ince, ki sahte ile gerçek
davranışta ayrışmasın.

### Sızıntı kuralı koda ve teste bağlandı

`POST /market/:id/bond` yanıtı **her zaman `position: null`** döndürüyor,
testi var. Sıra yayınlansaydı son agent daha rapor vermeden referans olacağını
bilirdi (PLAN Bölüm 6.4).

`GET /market/:id` `pendingAgentId` ve `drawnAgents` göstermiyor, test bunu
string araması ile doğruluyor.

### Dinamik fiyatlandırma

x402'nin `DynamicPrice` desteği var ve `context.adapter.getBody?()` ile gövdeye
erişiliyor.

`POST /market` fiyatı gövdedeki parametrelerden `depositTinybar()` ile
hesaplanıyor — **handler'ın kullandığı fonksiyonun aynısı.** Ayrı ayrı
hesaplansalardı ayrışabilirlerdi; ayrışma, ödeyebileceğinden fazlasını
ödemeye söz vermiş bir market demek.

`POST /market/:id/bond` fiyatı o marketin kendi bond miktarından geliyor.
`:id` deseni destekleniyor (x402 eşleştiricisi `:param`, `[param]` ve `*`
çeviriyor).

### Yeni paket: `@ethonline/env`

dotenv çalışma dizini tuzağı üçüncü kez çıktı (SPIKE A, ADIM 12, şimdi
apps/api). `scripts/load-env.ts` paket kökü dışında kaldığı için apps/api
import edemedi.

Ayrı pakete taşındı. Kök `pnpm-workspace.yaml` aranarak bulunuyor, sabit
sayıda `..` ile değil — paket yeri değişirse sessizce bozulmasın.

### Benim test hatam: sahte hash'te float taşması

Sahte ledger'ın running hash üreticisini düz `*` ile yazmışım. `sequence *
2654435761` ardından tekrarlı çarpmalar 2^53'ü aşıp alt bitleri sıfırlıyor ve
**bütün sequence'ler aynı hash'e çöküyordu** — sahtenin var olma sebebi olan
tek özelliği sessizce bozuyordu. `Math.imul` ile 32 bit uzayına alındı.

Kodda değil test double'ında bir hataydı ama gerçek bir hata: ADIM 16 turları
bu sahte ledger'a karşı koşacak, hash'ler ilerlemezse market hiç ilerlemez.

### Bu dosyada bulduğum bozukluk düzeltildi

ADIM 11 kaydını eklerken ADIM 10 kaydının **ortasındaki** bir cümleye
tutunmuşum; ADIM 10'un "sapmalar / tuzaklar / kalan risk" bölümleri dosyanın
en sonuna itilmişti. Yerine taşındı, bölüm sırası doğrulandı.

### Route özeti

| Yol | Erişim |
|---|---|
| `POST /market` | ödemeli (deposit) |
| `POST /market/:id/bond` | ödemeli (bond) |
| `POST /resolve` | ödemeli — **501, ADIM 22'de doldurulacak** |
| `POST /market/:id/report` | imzalı, ücretsiz |
| `POST /agents/register` | **herkese açık**, ödeme yok, allowlist yok |
| `GET /markets`, `/market/:id`, `/market/:id/reports`, `/agents`, `/health` | açık |

### Kalan risk

Market durumu bellekte. HCS kalıcı kayıt olduğu için kayıp, çalışan bir
marketi kaybetmek demek, geçmişi değil. Mekanizma bitmeden veritabanı eklemek
yanlış probleme harcanan emek olurdu; ADIM 32'de README'de belirtilecek.

`POST /market/:id/report` çalışması için agent'ın önce çekilmiş olması
gerekiyor (`pendingAgentId`). O sıralama ADIM 16'nın işi; endpoint hazır,
sürücüsü yok.

ADIM 4 (ENS spike) hâlâ açık.

---

## ADIM 16 — Orchestrator ve Ödeme Yürütücü

- **Tarih:** 2026-09-10
- **Durum:** GEÇTİ
- **Test:** 36 yazıldı, 36 geçti (16 transfer planı + 20 orchestrator)
- **Tam suite:** 380/380 yeşil, build temiz
- **Kanıt:** `pnpm check:orchestrator` — testnet'te tam market, 15 kontrol PASS

### Zincir üstü sonuç

```
Market:   mkt-2026-09-10-001  (topic 0.0.10457908)
Bond:     20 agent × 1 HBAR, hepsi kendi hesabından x402 ile
Raporlar: 5   (2 skorlu + 3 sabit ücret — k=3 ile birebir doğru)
Plan:     2.099.314.719 tinybar giren = çıkan
Hazine:   delta 0.00000000 HBAR
Defter:   8 olay, consensus sırası bozulmadan
```

**Hazine deltasının tam sıfır olması bu adımın asıl sonucu.** Giren para
(deposit + 20 bond) kuruşu kuruşuna çıktı. Muhasebe planda değil zincirde
kapandı.

### YUVARLAMA KURALI — paranın yaratıldığı veya yok olduğu yer

`core` soyut birimlerle ve kayan noktayla settle ediyor, zincir tam tinybar
taşıyor. İkisi arasındaki köprü paranın sessizce yaratılabildiği tek yer.

**Kural: her agent AŞAĞI yuvarlanır, kalan tam olarak askere gider.**

Agent'ı aşağı yuvarlamak en fazla bir tinybar'ın altında eksik ödeme yapar.
Yukarı veya en yakına yuvarlamak, ödemelerin **hazinede olandan fazla**
toplamasına yol açabilir — hazinede deposit + bond'lar var, bir kuruş fazlası
yok. Asker kalanı tasarım gereği emiyor, şans eseri değil. Ve kimlik tam
sayıda kapanıyor:

```
deposit + Σ bond  ==  Σ transfer
```

Tolerans değil, **tam eşitlik**. 100 rastgele markette ve yalancılı
senaryolarda test ediliyor. Dengelemeyen bir plan hiç gönderilmiyor,
`buildTransferPlan` hata fırlatıyor.

Bu asimetri bir testte kendini gösterdi: `1.1 * 1e8 = 110000000.00000001`,
yani fiyat helper'ı (yukarı) 110000001, ödeme (aşağı) 110000000 veriyor.
Testte yanlışlıkla fiyat helper'ını beklenen değer olarak kullanmıştım.

### Turdaki sıra — bu adımın kalbi

```
1. agent çek          SON mesajın running hash'ini kullanır
2. rapor iste         HTTP, süre sınırıyla
3. raporu HCS'e yaz   YENİ bir running hash üretir
4. durma zarı at      o yeni hash'ten
```

4, 3'ten sonra gelmek zorunda. Zar, **az önce yazılan raporun** hash'inden
gelmeli; o hash ağ consensus'a varana kadar var olmadığı için kimse —biz dahil—
marketin nerede duracağını önceden bilemiyor.

Test bunu doğrudan ölçüyor: turdan sonra `stop` çekilişinin kullandığı hash,
tur başındaki hash'ten farklı ve mevcut hash'e eşit olmalı.

### Timeout bir tur değildir

Agent cevap vermezse bond slash, havuzdan düşer, **zar ATILMAZ**. Aksi halde
sessiz kalarak marketi erken kapatmak mümkün olurdu ve bu herkesin çekebileceği
bir kol demek.

Ama zar atılmasa da HCS'e `timeout` mesajı yazılıyor ve rastgelelik kaynağı
güncelleniyor: sonraki çekiliş taze entropi almalı.

### Kullanılamaz cevap da timeout sayılıyor

Bozuk imza veya `[0,1]` dışı olasılık, sessizlikle aynı şekilde slash ediliyor.
Olmasaydı, pozisyonunu beğenmeyen bir agent kasten çöp gönderip skorlanmaktan
kurtulur ve teminatını da korurdu — mekanizmadan bedava bir opsiyon.

Testte tam bunu kuruyoruz: doğru agent id'siyle ama **başka agent'ın anahtarıyla**
imzalanmış bir rapor gönderiliyor, sonuç `timed-out`.

### BEŞİNCİ TUZAK — ardışık x402 ödemeleri

20 agent sırayla bond yatırırken **9.'da 402 geldi.** Aynı agent tek başına
denendiğinde sorunsuz ödedi (201 + settlement). Bakiyesi 10 HBAR'da kalmıştı,
yani başarısız denemede para hiç hareket etmemişti.

Yani hesap sorunu değil, hızlı ardışık ödemelerde geçici bir durum. 20 agent'ın
sırayla bond yatırması marketin normal açılış şekli olduğu için bu script'e
değil koda ait: `payWithRetry` eklendi.

**Tekrar denemeyi güvenli yapan şey ne:** 402 genelde "ödeme settle olmadı"
demek, ama "facilitator settle etti ve yanıt kayboldu" buradan aynı görünüyor
ve onu tekrarlamak iki kez ödeme yapar. Bu yüzden tekrar kararı ödeme
sonucuna değil **sunucu durumuna** bakıyor: bond zaten kayıtlıysa kayıp yanıt
aslında settle olmuş demektir, tekrar gönderilmiyor.

İkinci koşuda 20 bond'un hepsi geçti.

### ALTINCI TUZAK — mirror node'da geçici fetch hatası

Settlement bittikten sonra defteri geri okurken çıplak bir `fetch failed`
koşuyu öldürdü. Mekanizmada hiçbir sorun yoktu.

`readTopicMessages`'a tekrar deneme eklendi. Ödemede asla yapılamayacak bir şey
burada güvenli: bu idempotent bir GET, tekrarı bedava ve hiçbir şeyi
değiştirmiyor.

**Ama HTTP durum kodu tekrarlanmıyor.** 404 bir cevaptır, arıza değil — topic
gerçekten yok demek. Ağ hatası ile "böyle bir topic yok" aynı şekilde ele
alınırsa doğrulayan kişi yanlış sonuca varır. Testi var.

### Üç enjeksiyon noktası

`Ledger` (ADIM 15'ten), `AgentTransport` ve `Payer`. Üçü de sahtelenebiliyor,
dolayısıyla tur döngüsünün ve settlement muhasebesinin tamamı ağa çıkmadan
test ediliyor — 20 orchestrator testi, hepsi saniyeler içinde.

Bu olmasaydı "timeout zar atmıyor" gibi bir kuralı doğrulamak için her
seferinde testnet'te bir agent'ı susturmak gerekirdi.

### Settlement sırası: önce kayıt, sonra para

HCS'e settlement mesajı transferlerden **önce** yazılıyor. Bir transfer
başarısız olursa ne olması gerektiği zaten kamuya açık kayıtta duruyor ve
gerçekte ne olduğuyla karşılaştırılabiliyor. Ters sıra, ne olması gerektiğini
söyleyen hiçbir şey olmadan kısmi bir ödemeye izin verirdi.

### Transferler neden birden fazla işlem

Hedera tek bir transferin dokunabileceği hesap sayısını sınırlıyor; 20 agent +
asker bir işleme sığmıyor. Plan 9'arlı parçalara bölünüyor, her parça tek bir
atomik `TransferTransaction`.

**Parçalar birbirine göre atomik değil.** Gerçek bir kısıt; step-log'a
yazılıyor ve README'de belirtilecek. Koşuda 3 işlem çıktı, hepsi SUCCESS.

### `core`'a küçük ekleme: `Market.markSettled()`

Orchestrator `getState().status = 'settled'` yazmaya çalışıyordu, build
reddetti (`Readonly<MarketState>`). Doğru olan da bu: durum geçişi state
machine'in sorumluluğu. `markSettled()` sadece kapanmış marketi settled
yapıyor, aksi halde hata fırlatıyor — ödemeler dağıtılmadan bir market settled
görünemez.

### Kalan risk

Parça atomikliği yukarıda. Bir de: settlement başarısız bir parçadan sonra
tekrar çalıştırılırsa ödenmiş parçalar yeniden ödenir. ADIM 17'de bu senaryo
düşünülmeli — ya parça sonuçları kalıcı olarak kaydedilmeli ya da settlement
idempotent hale getirilmeli.

ADIM 4 (ENS spike) hâlâ açık.

---

## ADIM 17 — Hedera Uçtan Uca Entegrasyon Testi

- **Tarih:** 2026-09-10
- **Durum:** GEÇTİ (2026-09-10 15:04 kapandı). Gün içinde KISMEN GEÇTİ olarak
  yazılmıştı: iki test zincirde ayrı ayrı geçiyordu ama aynı koşuda ikisi
  birden yeşil olmamıştı. Engelleyen şey kod değil ağdı; facilitator gecikmesi
  düşünce **tek koşuda ikisi de geçti, kodda hiçbir değişiklik yapılmadan.**
- **Test:** 2 entegrasyon testi + 6 birim testi (hata yolları)
- **Tam suite:** 387/387 yeşil, build temiz

### Ne yazıldı

`apps/api/test/e2e-hedera.integration.test.ts` — ROADMAP'in istediği her şeyi
kapsıyor:

| İstenen | Durum |
|---|---|
| Asker x402 ile öder, market açılır | ✓ zincirde doğrulandı |
| 20 agent bond yatırır | ✓ |
| Turlar çalışır, market kapanır | ✓ |
| Settlement yürütülür, bakiyeler kontrol edilir | ✓ hazine deltası = slash |
| HCS mesaj sayısı = rapor + 3 | ✓ |
| Her durma kararı `verifyStoppingDecision` ile doğrulanır | ✓ |
| Timeout senaryosu, durma zarının atlanmadığı | ✓ zincirde doğrulandı |

`apps/api/test/e2e-harness.ts` — testnet iskelesi. Kimlik bilgisi yoksa test
temiz şekilde atlıyor: çalışamayan bir entegrasyon testi başarısızlık değil.

### KOŞU GEÇMİŞİ — dürüst kayıt

| Koşu | Test 1 (tam market) | Test 2 (timeout) |
|---|---|---|
| A | ✓ 84 sn | ✗ (testim deterministik değildi) |
| B | ✗ 500 | ✗ 500 |
| C | ✓ | ✗ 500 |
| D | ✗ 500 | ✓ 220 sn |

**İkisi de gerçek testnet'te geçti, ama hiç aynı koşuda değil.** Kalan bütün
hatalar market açılışında 500 ve hepsi ağ kaynaklı.

### Engelleyen şey ölçüldü

```
facilitator (api.testnet.blocky402.com):  connect 10-14 sn  (sabah 0.4 sn'ydi)
hedera mirror node:                        connect 0.12 sn
check:hedera (normalde ~15 sn):            1 dk 27 sn
```

Yani genel bir internet kesintisi değil, **özellikle facilitator'a giden yolun
gecikmesi.** Bu makineden, bugün.

### VE BU YOLDA ÜÇ GERÇEK EKSİK BULUNDU

Ağ arızası kendi başına bir bulgu değil; bulgu, arızanın koda neyi
gösterdiği.

**1. Kesin sınır: `@x402/express` 500'ü kendisi yazıyor.**

```js
// @x402/express dist, satır 146
res.status(500).json({ error: "Internal Server Error" });
```

Facilitator'a ulaşılamayınca middleware yanıtı doğrudan gönderiyor. Header'lar
çıktığı için **ne bir wrapper ne bir Express error handler araya girebiliyor.**
Kütüphane sınırı, uygulama katmanından düzeltilemez.

Yapılabilecek olan yapıldı: açılışta ısıtma, açılışta net rapor, ayarlanabilir
zaman aşımı, istemci tarafında tekrar deneme. README'de belirtilmeli — bir
facilitator kesintisi çıplak 500 olarak görünür.

**2. `next(err)` yolu açıktaydı.**

`withFacilitatorErrors` fırlatılan ve reddedilen hatayı yakalıyordu ama
middleware `next(err)` çağırırsa hata doğrudan Express'in varsayılan
işleyicisine gidiyor ve gövdesiz bir 500 dönüyordu.

`errorHandler` eklendi: ağ kaynaklı hatalar 503, gerçek programlama hataları
sebebiyle birlikte 500. Çağıran "isteğini düzelt" ile "makine takıldı, tekrar
dene" arasını ayırt edebilmeli — ikisi zıt tepki gerektiriyor.

**3. Ödeme kapısı bütün route'ların önündeydi.**

Global mount edilmiş bir ödeme kapısı, facilitator'a ulaşamayınca **okuma
uçlarını da beraberinde götürüyordu** — oysa hayatta kalması gereken tam
onlar. Zincire yazılmış bir market hâlâ herkesçe doğrulanabilmeli.

`onlyPaidRoutes` eklendi: kapı sadece para isteyen üç route için çalışıyor.
Kesinti sırasında yeni market açılamıyor (doğru), ama kayıt okunabilir kalıyor.

### Ayrıca: facilitator zaman aşımı ayarlanabilir oldu

Kütüphane varsayılanı 10 sn ve el sıkışmayı da kapsıyor. Yavaş bir hatta
istemci, facilitator daha cevap vermeden vazgeçiyor ve bütün ödemeli route'lar
ödemeyle ilgisi olmayan bir sebeple düşüyor. Varsayılan 30 sn'ye çekildi,
`FACILITATOR_TIMEOUT_MS` ile ayarlanabilir.

Bu değişiklikle 500'ler 502'ye döndü (yani ödeme geçti, Hedera çağrısı
takıldı) — ilerleme ölçülebilir oldu.

### Test kurgusu hatam: rastgeleliğe bağlı iddia

İlk timeout testinde **tek** bir agent'ı susturup slash edilmesini bekledim.
Ama çekiliş rastgele ve α=1/3 ile market ~3 turda kapanıyor; o agent hiç
çekilmeyebiliyor. Yazı-tura sonucuna bağlı bir test, testsizlikten kötüdür.

Yeniden kurdum: **bütün** agent'lar susuyor. İddia artık tam:
- 5 çekiliş, 5 timeout, 0 rapor
- **0 durma zarı** — testin var olma sebebi olan özellik
- market `pool-exhausted` ile kapanıyor
- dejenere settlement: referans yok, ödeme yok, bütün bond'lar slash, hepsi
  askere

"Timeout sonrası market devam eder" yolu birim testlerinde zaten deterministik
olarak kapsanıyor.

### KAPANIŞ KOŞUSU — 2026-09-10 15:02

```
apps/api/test/e2e-hedera.integration.test.ts  (2 tests)  162030 ms
  ✓ runs a full market and closes the books on chain   102937 ms
  ✓ slashes silent agents and rolls the dice ZERO times  59090 ms

Test Files  1 passed (1)
Tests       2 passed (2)
Duration    164.15 s
```

Koşu öncesi ölçüm, dünkü tabloyla aynı formatta:

```
facilitator (api.testnet.blocky402.com):  connect 6.73 sn  (dun 10-14, sabah 0.4)
hedera mirror node:                        connect 0.11 sn
```

Yani facilitator hala normalden yavas ama ADIM 17'de 30 sn'ye cekilen zaman
asimi bu araligi tasiyor. Dun eklenen uc duzeltmenin (isitma, ayarlanabilir
timeout, `onlyPaidRoutes`) hicbiri geri alinmadi; tek degisken agdi.

### Kalan iş

ADIM 16'da not düşülen iki kısıt duruyor: transfer parçaları birbirine göre
atomik değil, ve settlement kısmi bir başarısızlıktan sonra tekrar
çalıştırılırsa ödenmiş parçalar yeniden ödenir.

ADIM 4 (ENS spike) hâlâ açık.

---

## ADIM 18 — Graph Gateway Client

- **Tarih:** 2026-09-10
- **Durum:** GEÇTİ
- **Test:** 90 yazıldı, 90 geçti, 0 kaldı
- **Tam suite:** 477/477 yeşil (2.91 sn), `pnpm -r build` temiz

### Kullanılan sürümler

| Paket | Sürüm |
|---|---|
| @graphprotocol/client-x402 | 1.0.0 |
| @x402/fetch (transitif) | 2.25.0 |
| @x402/evm (transitif) | 2.25.0 |

### Yazılanlar

| Dosya | İş |
|---|---|
| `packages/graph/src/x402.ts` | 402 daveti ve settlement makbuzunun çözülmesi. Bağımlılık yok |
| `packages/graph/src/errors.ts` | `GraphQueryError` + `kind` + `retryable` |
| `packages/graph/src/gateway.ts` | `GraphGateway`: iki mod, retry, maliyet muhasebesi |
| `packages/graph/src/x402-fetch.ts` | Ödeme yapan fetch, dinamik import |
| `packages/graph/src/env.ts` | `.env`'den yapılandırma ve fabrika |
| `scripts/check-graph.ts` | Canlı gateway'e karşı manuel kapı (`pnpm check:graph`) |

### CANLI GATEWAY'DEN ÖĞRENİLEN İKİ ŞEY

Bunların ikisi de ADIM 3'ün notlarında yoktu ve ikisi de kodu değiştirdi.

**1. 402 daveti gövdede değil, `payment-required` header'ında.**

ADIM 3 daveti JSON gövde olarak kaydetmişti. Bugün ölçülen:

```
POST https://gateway.thegraph.com/api/x402/subgraphs/id/<id>
-> HTTP/1.1 402 Payment Required
   Content-Length: 0
   payment-required: <base64 JSON>
```

Gövde **sıfır bayt.** O nota göre yazılmış bir istemci `await res.json()`
çağırır, sıfır baytta parse hatası alır ve tamamen olağan bir ödeme talebini
"bozuk yanıt" diye raporlar. Header'ın kendisi test dosyasına birebir fixture
olarak konuldu; gateway fiyatı değiştirirse kırmızı test olarak görünür.

Davetin içeriği: `eip155:8453` (Base **mainnet**), 10000 raw USDC = **$0.01**,
`eip3009` (gasless — ödeyen imzalar, gas'ı facilitator öder, yani agent'ın ETH
tutmasına gerek yok).

**2. Auth hatası HTTP 200 dönüyor.**

```
POST /api/subgraphs/id/<id>   (Authorization header yok)
-> HTTP 200
   {"errors":[{"message":"auth error: missing authorization header"}]}
```

`res.ok` true. Sadece `res.ok`'e bakan bir istemci `body.data` okur, `undefined`
alır ve agent'a **boş kanıt kümesi** verir. Agent yine de bir olasılık raporlar
ve o rapor paranın kime gideceğini belirler. Bu yüzden GraphQL `errors` dizisi
burada uyarı değil, fırlatılan hata. Kısmi veri (`data` + `errors` birlikte) de
reddediliyor: yarısı eksik bir kanıt kümesi üzerinde akıl yürütmek, hiç veri
almamaktan daha tehlikeli çünkü eksiklik görünmüyor.

### Tasarım kararları

**Ödeme asla tekrar denenmiyor.** x402 modunda her deneme yeni bir ödeme. 402'yi
geçici sayan bir retry döngüsü, hiç gelmeyen cevaplar için üst üste para öder.
`retryable` yalnızca network hatası, 429 ve 5xx için true. Hedera retry
politikasındaki doktrinin aynısı: tanınmayan hata kalıcı sayılır.

**Maliyet ikiye ayrılıyor: `settled` ve `estimated`.** Settlement makbuzu paranın
gerçekten hareket ettiğinin tek kanıtı. Ama makbuz miktar taşımıyorsa dolar
rakamı yine liste fiyatından geliyor. Bu kombinasyon (settled=true,
estimated=true) olduğu gibi raporlanıyor. Ödeme yapılıp sonra başarısız olan
sorgu da muhasebeye giriyor — para gitti, veri gelmedi.

**Ondalık tahmin edilmiyor.** 402 daveti miktar ve varlık adresi veriyor ama
ondalık sayısını vermiyor. USDC için 6 varsaymak doğru, 18 ondalıklı bir token
için 12 basamak yanlış olur. `KNOWN_ASSETS`'te olmayan varlık için dolar rakamı
**verilmiyor**, ham miktar veriliyor.

**Ödeme sarmalayıcısı için Graph'in kendi paketi kullanıldı.** Kendi
sarmalayıcımızı yazıp harcama tavanı koymak cazipti, ama `x402Client` zaten
varsayılan spend control uyguluyor ve USDC tanınan varlık. Üstelik bu yol
offline test edilemiyor (test USDC yok, testnet gateway yok), dolayısıyla
bizden başkasının da çalıştırdığı sürüm daha değerli. Kaçış kapısı açık:
`GraphGateway` herhangi bir `fetchImpl` kabul ediyor.

### Testnet gateway hâlâ ölü

`testnet.gateway.thegraph.com` için A kaydı bugün de yok (Google public DNS,
`http=000`). ADIM 3'ün bulgusu duruyor: **x402 = gerçek para.** Bu yüzden
varsayılan mod `.env.example`'da `apikey`'e çekildi ve `check:graph` x402
modunda ödeme yapmıyor — `--pay` bayrağı gerekiyor.

### Kanıt

```
pnpm check:graph
  [PASS] Gateway asks for payment (HTTP 402)
  [PASS] Challenge arrives in the "payment-required" header
         body is 0 bytes — the challenge is NOT in it
  [PASS] Decoded with our own decoder (x402 v2)
         network  eip155:8453
         asset    0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (USDC)
         amount   10000 raw
  [PASS] Price resolves to a dollar figure   $0.01 per query
         transfer eip3009 (gasless: payer needs no ETH)
  [PASS] Unauthenticated query answers HTTP 200, not 401
  [PASS] Client refuses to read that as data (kind: graphql)
  [PASS] Nothing was charged for it
  [SKIP] 3. A REAL QUERY — kimlik bilgisi yok
ALL CHECKS PASSED
```

### Kalan iş

Kabul kriterinin "her iki modda da sorgu çalışıyor" maddesi **yarım**: canlı
sorgu hiçbir modda çalıştırılamadı çünkü `.env`'de ne `GRAPH_API_KEY` ne
`GRAPH_X402_PRIVATE_KEY` var. Kodun her iki yolu da birim testlerinde kapsanıyor
ve 402/200-auth davranışı canlı gateway'e karşı doğrulandı, ama uçtan uca sorgu
kanıtı için gereken:

1. **Studio API key** (ücretsiz, thegraph.com/studio) → `pnpm check:graph` 3.
   bölümü yeşile döner, ADIM 19 gerçek veriyle yazılabilir.
2. Demo/video için Base ağında ~$10 USDC → `pnpm check:graph --pay`.

ADIM 19 (veri dilimleri) kabul kriteri "5 dilim de **gerçek veri** dönüyor"
diyor, yani (1) olmadan ADIM 19 tamamlanamaz.

ADIM 4 (ENS spike) hâlâ açık.

---

## ADIM 19 — Veri Dilimleri

- **Tarih:** 2026-09-10
- **Durum:** KISMEN GEÇTİ — kod ve testler tamam, kabul kriterinin "gerçek veri"
  maddesi kimlik bilgisi olmadığı için doğrulanamadı. Ayrıntı aşağıda.
- **Test:** 77 yazıldı, 77 geçti, 0 kaldı
- **Tam suite:** 554/554 yeşil (3.28 sn), `pnpm -r build` temiz

### Yazılanlar

| Dosya | İş |
|---|---|
| `slices/types.ts` | `DataSlice`, `SliceEvidence`, `SliceSignal`, `QuestionContext` |
| `slices/stats.ts` | Ortak matematik: HHI, top-N pay, varyasyon katsayısı, yüzdelik |
| `slices/liquidity.ts` | Havuz derinliği, TVL konsantrasyonu, devir hızı |
| `slices/holders.ts` | Deposit akışından yatırımcı konsantrasyonu, geri dönmeyen adres |
| `slices/activity.ts` | Zamanlama düzenliliği, self-trade, tekrar eden gönderen |
| `slices/bridge.ts` | Zincirler arası giriş/çıkış, rota konsantrasyonu, self-bridge |
| `slices/comparative.ts` | Tek sorgu deseni, 5+ protokol, yüzdelik sıralama |

### SORGULAR HAFIZADAN YAZILMADI

Messari'nin gerçek şeması indirildi (`schema-dex-amm.graphql` 822 satır,
`schema-bridge.graphql`) ve bütün alan adları oradan alındı. Sebep: gateway'e
sorgu atacak kimlik bilgimiz yok, yani yanlış bir alan adı ancak demo günü
ortaya çıkardı. Test fixture'ları da aynı gerçek alan adlarını kullanıyor.

**Şemadan çıkan iki kısıt tasarımı değiştirdi:**

1. **`Account` entity'sinde sadece `id` var.** Bakiye alanı yok. Yani "holder
   konsantrasyonu" bakiyeden okunamıyor. Hafızadan yazan biri olmayan bir
   bakiye alanına uzanır, gateway HTTP 200 + GraphQL hatası döner, ve ADIM
   18'deki kontroller olmasa bu agent'a **boş kanıt kümesi** olarak ulaşırdı.
   Çözüm: konsantrasyon **stoktan değil akıştan** türetiliyor — pencere
   içindeki `Deposit` olaylarının `from` + `amountUSD` alanları adres bazında
   toplanıyor. Bu farklı bir büyüklük (pencere öncesi yatırılan sermayeyi
   görmüyor) ve bu, örtülmek yerine kalıcı bir caveat olarak raporlanıyor.

2. **Standartta gas alanı yok.** `Event` arayüzünde `hash`, `logIndex`, `to`,
   `from`, `blockNumber`, `timestamp` var, başka bir şey yok. ROADMAP'in
   activity dilimi için önerdiği "gas desenleri" bu yüzden yazılamadı.
   Standarttan çıkıp tek alan için özel subgraph'a gitmek her dilimin dayandığı
   çok-protokol kaldıracını yakardı. Yerine zamanlama ve tekrar ölçüleri kondu:
   varyasyon katsayısı, self-trade payı, tek-atış gönderen payı, yuvarlak
   miktar payı, saat konsantrasyonu.

### VARSAYIM 4 BİR TEST OLARAK YAZILDI

`slices.test.ts` içindeki en önemli assertion: aynı market beslendiğinde beş
dilim **kesişmeyen** sinyal kümeleri üretmeli. İki dilim aynı satırlardan aynı
istatistiği hesaplıyorsa bu iki oy kullanan tek dilimdir; δ → 1 gider ve Teorem
1'in istediği k onunla birlikte patlar. Test bütün dilim çiftlerini geziyor ve
ortak anahtar bulursa isim vererek kırmızıya düşüyor.

Ayrıca `check:graph --slices` aynı kontrolü canlı veride yapıyor.

### Dilimlerin gerçekten farklı olduğunun ikinci kanıtı

Activity dilimi iki fixture ile test ediliyor: 60 saniyede bir, tek adresten
kendisine, hep 10000 USD'lik 10 swap; ve 10 farklı adresten düzensiz aralıklı,
dağınık miktarlı 10 swap. Birincide `interarrival_cv = 0`, `self_trade_share =
1`, `round_amount_share = 1`. İkincide sırasıyla >1, 0, 0. Ölçü ayırt ediyor.

Comparative dilimi 6 protokole **tek sorgu metni** gönderiyor ve wash şeklindeki
denek turnover'da yüzdelik 1, revenue yield'de yüzdelik 0 çıkıyor — çok işlem
yapıp hiç ücret üretmeyen hacmin imzası.

### Bir dilim asla cevabı vermiyor

Dilimler kanıt ve türetilmiş sayı döndürüyor, hüküm değil. Hüküm dilimde olsaydı
20 agent yapı gereği aynı fikirde olurdu — ki bu dosyanın var olma sebebi tam
olarak bunu engellemek. Test bunu da kontrol ediyor.

### Testi değiştirdim, gerekçesi

İki assertion `toBeCloseTo(2/3, 10)` yazmıştı ve kırmızıydı. Sebep koddaki hata
değil: `signal()` çıkışta altı ondalığa yuvarlıyor (HCS defterindeki round6 ile
aynı sözleşme), ben API'nin hiç vermediği bir hassasiyeti iddia etmiştim.
Testleri `toBe(0.666667)` yaptım ve yuvarlama sözleşmesini örtük bırakmamak için
ayrı bir test ekledim. Bu testi gevşetmek değil, doğru sözleşmeyi test etmek.

### Kabul kriterleri

| Kriter | Durum |
|---|---|
| 5 dilim de gerçek veri dönüyor | **HAYIR** — kimlik bilgisi yok |
| Her dilim farklı entity/sorgu kullanıyor | EVET, test ediyor |
| `comparative` 5+ protokolü tek sorgu deseniyle tarıyor | EVET, test ediyor |
| Maliyetler raporlanıyor | EVET, dilim başına + toplam |

### Kalan iş

Studio API key (ücretsiz) + Messari standardize deployment id'leri gerekiyor.
Id'ler sabit yazılmadı, `.env`'e kondu (`GRAPH_SUBJECT_SUBGRAPH`,
`GRAPH_PEER_SUBGRAPHS`, `GRAPH_BRIDGE_SUBGRAPH`): hangi deployment'ın standarda
uyduğu gateway'e sorulmadan doğrulanamaz ve tahmin edilmiş bir id her birim
testini geçip canlıda patlardı.

İkisi girildiğinde tek komut kapıyı kapatıyor:

```
pnpm check:graph --slices
```

ADIM 4 (ENS spike) hâlâ açık.

---

## ADIM 16 SERTLEŞTİRME — Settlement'ın Yeniden Çalıştırılabilirliği

- **Tarih:** 2026-09-10
- **Durum:** GEÇTİ
- **Test:** 36 yazıldı (26 settlement-resume + 10 hcs-message), 36 geçti
- **Tam suite:** 588/588 yeşil (4.07 sn), `pnpm -r build` temiz
- **Neden bu iş:** ADIM 16'nın "Kalan risk" bölümündeki iki madde. Yeni adım
  değil, açık kalmış bir defekt.

### Kapatılan defekt

ADIM 16'nın kendi kaydı:

> settlement kısmi bir başarısızlıktan sonra tekrar çalıştırılırsa ödenmiş
> parçalar yeniden ödenir

Ciddi olan buydu. Çökme değil, **hazineden ikinci kez para çıkması** — ve
hiçbir şey fark etmezdi, çünkü `core`'daki bütün muhasebe değişmezleri neyin
ödenmesi *gerektiğini* tarif ediyor, neyin ödendiğini değil.

### Üç kural

**1. Plan bir kez hesaplanıyor ve saklanıyor.** Devam eden bir settlement
yeniden hesaplamıyor. Aksi halde "zaten ödendi" artık var olmayan bir plan
hakkında bir iddia olurdu. `StoredMarket.settlementProgress` bunun için var ve
oradaki tek mutable alan.

**2. Onaylanmayan parça `unknown`, `failed` değil.** Transfer hata fırlattığında
işlemin zincire yazılıp yazılmadığını **bilmiyoruz**. "Yazılmadı" varsaymak tam
olarak iki kez ödeten varsayım. Böyle bir parça settlement'ı durduruyor ve
hazinenin işlem geçmişine bakmış bir insanın kararını bekliyor:

```
resolveSettlementChunk(marketId, index, 'paid' | 'not-paid', evidence)
```

Kanıt zorunlu ve açıkladığı ödemenin yanına, kamuya açık kayda yazılıyor.
Otomatik karar veren bir sürümü mümkün (mirror node sorgusu) ama `paid`
yönünde yanlış cevap agent'ı sessizce eksik ödüyor, `not-paid` yönünde iki kez
ödüyor. İkisi de çıkarımdan verilecek karar değil.

**3. İlerleme HCS'e yazılıyor.** Yeni mesaj tipi: `settlement-chunk`. Bellek
restart'ı atlatmıyor ve restart, tekrar çalıştırmanın en muhtemel olduğu an.
Topic atlatıyor, consensus ile sıralı ve herkes HashScan'e karşı
doğrulayabiliyor.

### Yazma sırası, ve neden

Parça makbuzunu yazamamak **para hareketini geri almamalı**. `writeChunkOutcome`
hata fırlatmıyor: fırlatsaydı parçanın ödendiğini söyleyen bellek durumu
kaybolur ve sonraki devam onu tekrar öderdi. Makbuz kaybı denetlenebilirliğe
mal oluyor — ikisinin ucuz olanı bu. Kayıp bir olay olarak raporlanıyor
(`settlement-chunk-unrecorded`), sessizce yutulmuyor.

### Zaten settled olan markete settle() çağırmak

Artık hata değil, kayıt döndüren bir no-op. Yanıtı kaybolmuş bir çağıran
"borç yok" öğrenmeli, yeni bir denemeye davet eden bir hata değil.

### Parça atomikliği — düzeltilmedi, düzeltilemez

ADIM 16'nın diğer maddesi. Hedera tek bir transferin dokunabileceği hesap
sayısını sınırlıyor (9 alacak + 1 borç), 20 agent + asker sığmıyor. Birden
fazla işlemi birbirine göre atomik yapmak protokol seviyesinde mümkün değil.

Değişen şey, atomik olmamanın **tehlikeli** olan sonucuydu: yarıda kalan bir
settlement artık nerede kaldığını söylüyor, güvenle devam ettirilebiliyor ve
kayıtta duruyor. Sessiz bir tehlike, görünür ve kurtarılabilir bir duruma
dönüştü.

Bir de sıralama: **asker satırı planın en sonunda.** Kısmi başarısızlıkta
ödenmemiş kuyrukta kalan kişi bu. Agent'ların teminatı ödenene kadar kilitli,
asker ise marketi başlatan ve fonlayan taraf; bekleyecek olan asker olmalı. Bu
zaten böyleydi ama kasıt mı tesadüf mü belli değildi — artık yorumda ve testte.

### Kanıt

```
apps/api/test/settlement-resume.test.ts (26 tests)

  ✓ THE DEFECT: re-running a partial settlement
      ✓ DOES NOT PAY A CHUNK THAT ALREADY WENT THROUGH
      ✓ throws the same blocked error rather than pretending to make progress
      ✓ reuses the stored plan instead of recomputing it
      ✓ writes the settlement message only once
  ✓ resolving an unknown chunk (7 tests)
  ✓ when the ledger cannot record a chunk (2 tests)
  ✓ who waits when a settlement stops partway (2 tests)
```

Yük taşıyan test birincisi. Eski kodda kırmızı olurdu: `settle()` planı baştan
hesaplayıp 0. parçayı ikinci kez gönderirdi.

### Kalan iş

ADIM 17'nin entegrasyon testi bu yolu zincirde denemiyor — orada payer gerçek
ve kasten patlatmak zor. `unknown` yolunun canlı doğrulaması ADIM 31'de
(demo senaryoları) yapılabilir, ya da hiç yapılmaz ve birim testleri yeterli
sayılır. Bu bir karar, eksik değil.

ADIM 4 (ENS spike) hâlâ açık.

---

## ADIM 27 — Market Listesi ve Soru Sorma

- **Tarih:** 2026-09-10
- **Durum:** KISMEN GEÇTİ — sayfalar ve deposit hesabı bitti, **cüzdan + x402
  ödemesi yapılmadı.** Ayrıntı aşağıda.
- **Test:** 15 yazıldı, 15 geçti
- **Tam suite:** 603/603 yeşil, `pnpm -r build` temiz

### ROADMAP'ten sapma: Next.js yerine Vite

ROADMAP "Next.js App Router, Tailwind" diyor. Vite + React + Tailwind yapıldı.
Gerekçe, önem sırasıyla:

1. **Tek servis, tek origin.** Build `dist/`'e çıkıyor ve mevcut Express API
   onu statik servis ediyor. Frontend ile ödemeli API aynı origin'de: CORS yok,
   ikinci deployment yok, x402 akışı yüklendiği host'la konuşuyor.
2. **Hiçbir sayfa sunucu istemiyor.** Dört sayfa, hepsi REST okuyup polling
   yapıyor. SSR yok, SEO yok.
3. **Repo'da hiçbir yerde build adımı yok.** Her paket tsx ile kaynaktan
   koşuyor, `build` = `tsc --noEmit`. Statik bir bundle buna uyuyor, ikinci bir
   Node runtime uymuyor.

### Yol çakışması ve verilen karar

`/market/:id` ve `/agents` hem API route'u hem doğal sayfa adı. Production'da
aynı Express uygulaması ikisini de servis ettiği için sayfa, API tarafından
gölgelenirdi.

Temiz çözüm API'yi `/api` altına almaktı ve **reddedildi**: o yollar x402 ödeme
kapısının konfigüre edildiği ve ADIM 17'nin testnet'te uçtan uca doğruladığı
yollar. URL'ler güzelleşsin diye ödeme rayını yeniden doğrulamak, bu sistemde
en az kurcalanası yer.

Sayfalar taşındı, API yerinde kaldı: `/` liste, `/new` soru, `/m/:id` market,
`/directory` agent dizini.

### Demo sunucusu (`pnpm demo`)

Frontend'i testnet'e karşı geliştirmek her reload'da zincir zamanı demek ve
facilitator hıçkırığı frontend hatası gibi görünüyor. `scripts/demo-server.ts`
**aynı app nesnesini** birim testlerin kullandığı bellek-içi ledger üzerinde
koşturuyor ve her durumda market tohumluyor.

Gerçek olan: mekanizma. `core` değiştirilmeden koşuyor, agent'lar running
hash'ten çekiliyor, durma zarı o hash'lerden geliyor, settlement aynı
aritmetikten ve aynı değişmez kontrollerinden geçiyor. Sahte olan: ledger (Map),
payer (transferi kaydediyor, göndermiyor) ve agent inançları (senaryolu persona).

**Bellek-içi ledger `src/memory-ledger.ts`'e taşındı.** Testlerdeki kopya
silindi ve `test/helpers.ts` artık onu sarmalıyor. Ayrı bir kopya, demo'nun
kullandığı ledger'dan ayrışırdı ve testler kimsenin koşmadığı bir ledger
hakkında kanıt olurdu.

"Running" market tek denemede tutmuyor: durma zarı gerçek, market ilk raporunda
kapanabiliyor. Zorlamak yerine zar bir tanesini açık bırakana kadar market
açılıyor (bu koşuda 3 deneme). Erken kapanan marketler listede dürüstçe kapalı
olarak duruyor.

### Express 5 tuzağı

SPA fallback'i `app.get(/regex/)` ile yazmak **sunucuyu asıyor** — hata değil,
sessiz kilitlenme. Express 5 route'ları path-to-regexp v8'den geçiyor. Regex
route bırakıldı, yerine hangi yolun API'ye ait olduğuna JavaScript'te karar
veren düz bir middleware kondu. Üç satır ve bir sürüm yükseltmesi bozamaz.

### YANLIŞ YAZDIM, TEST YAKALADI

Ask sayfasına şunu yazmıştım: *"a confident prior is a cheaper market to
subsidise."* **Tam tersi.**

Sınır `b · max_i(−log q⁰_i)`, yani referans agent'ın nereye düşeceği üzerinden
**en kötü durum** — paper'ın `b·H(r, q⁰)` yazdığı ifade `r`'yi gerektiriyor ve
market açılırken `r` bilinmiyor. Prior %5'e çekilirse bir bileşen sıfıra
yaklaşıyor, `−log(küçük)` büyüyor: referans %95'e düşerse skorlama kuralı o
hareketin tamamını ödemek zorunda. Uniform prior en ucuz yer.

Ekrandaki **rakam zaten doğruydu** (core'dan geliyordu), yanlış olan metindi —
"formülü kopyalama" kararının somut faydası bu. Slider'ı oynatan biri deposit'in
arttığını görecek, metin ise azaldığını söyleyecekti.

Test, yorumlar ve arayüz metni düzeltildi. Ayrıca 50/50'nin altı farklı prior'a
karşı en ucuz olduğunu doğrulayan bir test eklendi.

### Deposit'in API ile aynı olduğu test ediliyor

ADIM 27'nin asıl kabul kriteri "deposit hesabı doğru". Frontend `requiredDeposit`
fonksiyonunu **doğrudan** `@ethonline/core`'dan çağırıyor — `core` saf TypeScript
olduğu için tarayıcıda değişmeden koşuyor. Test bunu API'nin `depositTinybar`
çıktısıyla tinybar hassasiyetinde karşılaştırıyor, üç parametre seti ve dört
prior için. Sabite karşı değil birbirine karşı: sabit, ikisi birlikte kayarken
de geçerdi.

### Kabul kriterleri

| Kriter | Durum |
|---|---|
| Liste gerçek API'den besleniyor | EVET |
| Deposit hesabı doğru ve canlı güncelleniyor | EVET, API ile eşliği test ediliyor |
| Soru sorup ödeme yapılabiliyor | **HAYIR** — aşağı bakınız |

### Yapılmayan: cüzdan bağlantısı ve x402 ödemesi

Form çalışıyor, doğrulama `core`'un kendi `validateParams`'ı, POST atılıyor.
Ödeme kapısı olmayan demo sunucusuna karşı market gerçekten açılıyor. Gerçek
sunucuya karşı 402 dönüyor ve arayüz bunu "tarayıcı cüzdanı henüz bağlı değil"
diye açıkça söylüyor — 503'ten ayrı, çünkü ikisi zıt tepki gerektiriyor.

Tarayıcıda Hedera x402 imzalamak ayrı bir iş: `@x402/hedera` Node paketi,
tarayıcı desteği doğrulanmadı, ve cüzdan (HashPack vb.) entegrasyonu gerekiyor.
Kendi adımı olarak ele alınmalı; ADIM 27'nin geri kalanını buna bağlayıp
bekletmek anlamsızdı.

### Görsel doğrulama yapılmadı

Chrome eklentisi bu oturumda bağlı değildi, ekran görüntüsü alınamadı. HTTP
seviyesinde doğrulandı: dört sayfa da 200 dönüyor, SPA fallback çalışıyor, API
route'ları gölgelenmiyor. **Ekranların gerçekten doğru göründüğü henüz kimse
tarafından görülmedi** — `pnpm demo` çalıştırılıp göze bakılması gerekiyor.

### Kanıt

```
pnpm --filter @ethonline/web build
  dist/index.html                   0.41 kB
  dist/assets/index-DMEtul7s.css   20.69 kB   gzip: 4.88 kB
  dist/assets/index-DyqQom4Q.js   281.29 kB   gzip: 89.33 kB

pnpm demo
  bonding    mkt-2026-09-10-001
  running    mkt-2026-09-10-004  (4 reports, 3 attempt(s))
  settled    mkt-2026-09-10-005
  settled    mkt-2026-09-10-006  (one agent reports the opposite on purpose)

  /            200      /m/x         200
  /new         200      /directory   200
  GET /markets -> 6 markets
```

ADIM 4 (ENS spike) hâlâ açık.

---

## ADIM 28 — Canlı Market Sayfası

- **Tarih:** 2026-09-10
- **Durum:** KISMEN GEÇTİ — sayfa, grafik, rapor akışı ve kapanış paneli bitti;
  **görsel doğrulama yapılamadı** (Chrome eklentisi bağlı değil).
- **Test:** 21 yazıldı (13 API ucu + 8 grafik serisi), 21 geçti
- **Tam suite:** 624/624 yeşil (3.88 sn), `pnpm -r build` temiz

### Sayfanın istediği üç şey API'de yoktu

ROADMAP rapor kartında gerekçe, veri dilimi rozeti ve kanıt maliyeti istiyor;
kapanış panelinde de "durma kararının doğrulanabilir hash'i". Üçü de yoktu.

**1. Rapor açıklamaları (`ReportAnnotation`).** `core`'daki `Report` pozisyon,
inanç ve kırpmadan ibaret — mekanizmanın skorladığı her şey bu ve paket saf
kalmalı. Gerekçe/dilim/maliyet API katmanında, market'in yanında duruyor.

`AgentReportResponse` genişletildi: `reasoning`, `sliceIds`, `evidenceCostUsd`,
`evidenceDigest`. ADIM 20'nin gerçek agent'ı da aynı üç şeyi raporlayacak, yani
sayfa alacağı şekle karşı yazıldı.

**Gerekçe imzalanmıyor, bilinçli.** İmza olasılığı kapsıyor, çünkü mekanizmanın
skorladığı tek şey o. Serbest metni imzalı yüke sokmak, kritik yola sınırsız bir
string koymak demek ve karşılığında hiçbir şey vermiyor. Ekranda da böyle
etiketleniyor: agent'ın kendisi hakkındaki beyanı, kanıt değil.

**`evidenceDigest` ise HCS kaydına yazılıyor.** Hash sonradan doğrulanabilir,
düzyazı doğrulanamaz. ADIM 13'te "STEP 20'ye kadar opsiyonel" diye bırakılan
alan böylece bağlandı.

**2. `GET /market/:id/randomness`.** Mekanizmanın dürüstlüğü durma zamanının
tahmin edilemez olmasına dayanıyor ve bizimkine inanmanın tek sebebi, her zarın
ağ üzerinde uzlaşılana kadar var olmayan bir mesajın running hash'inden gelmesi.
Bu iddia doğrulanabilir — hash'ler mirror node'da açık — ama sadece hangi
hash'in neye karar verdiğini söylersek.

Uç şunu döndürüyor: her zar için hash, çıkan değer, amaç (`stop`/`draw`), ve
durma zarları için α ile karşılaştırma sonucu. Artı `howToVerify`: hangi bayt
aralığı, hangi sıra, kaç bit.

**SADECE GEÇMİŞ YAYINLANIYOR.** Bir zar, o pozisyondaki rapor var olduğunda
yayınlanıyor. Çekilmiş ama henüz rapor vermemiş agent'ın zarı gizli — onu
yayınlamak sırada kimin olduğunu söylerdi ve çekilişin tur tur yapılmasının
sebebi tam olarak sıranın önceden bilinememesi (PLAN 6.4). Bunun testi
`market-detail.test.ts` içinde ve dosyanın yük taşıyan testi o.

### Grafiğin şekliyle iddia ettiği iki şey

**Çizgi açılış fiyatından başlıyor**, ilk rapordan değil. Skorlama kuralı
**hareketi** ödüyor ve ilk agent'ın hareketi prior'dan. 1. rapordan başlayan bir
grafik, çoğu marketin yaptığı en büyük hareketi gizlerdi.

**Referans sadece kapanmış markette işaretleniyor.** Market koşarken son rapor
yalnızca en yenisi; onu cevap diye işaretlemek market'in çözüldüğünü iddia
etmek olurdu. Herkesin ödemesi referansa göre hesaplandığı için bu kozmetik
değil.

Ayrıca y ekseni [0,1]'e sabitlendi. Recharts kendi haline bırakılsa 0.68–0.74
aralığına zoom yapıp sıkıcı bir marketi dramatik gösterirdi. Yakınsamış bir
marketin düzlüğü bilgidir.

### Test hızı: recharts'ı birim suite'ten çıkardım

`buildSeries` önce bileşenin içindeydi ve testi recharts'ı çekiyordu — toplama
süresi **28 saniye**. ROADMAP'in kuralı açık: `pnpm test` saniyeler içinde
bitmeli. Saf seri mantığı `lib/series.ts`'e taşındı, süre **2.2 saniyeye**
indi. Zaten render hakkında hiçbir fikri olmayan aritmetiğin bileşen dosyasında
işi yoktu.

### Demo agent'ları artık gerekçe üretiyor

Rapor akışının işi, agent'ların **farklı kanıta baktıkları için** ayrıştığını
göstermek — Varsayım 4'ün görünür hali. Demo transport'u her agent'ın diliminin
diline uygun bir cümle üretiyor ve dilim rozetiyle birlikte gösteriliyor.
Yalancı agent'ın gerekçesi de dürüst: "bunu okudum, yine de tersini
raporluyorum."

### Kabul kriterleri

| Kriter | Durum |
|---|---|
| Grafik canlı güncelleniyor | EVET (2 sn polling, terminal durumda duruyor) |
| Raporlar geldikçe akışa ekleniyor | EVET |
| HCS linkleri çalışıyor | EVET (HashScan, topic id) |
| Kapanışta referans agent net işaretli | EVET (grafikte, akışta, panelde) |
| **Ekranın gerçekten doğru göründüğü** | **DOĞRULANMADI** |

### Kanıt

```
GET /market/mkt-2026-09-10-006/reports
  prior       [0.5, 0.5]
  position    1  agent-18
  prev->new   0.5 -> 0.71
  slices      ['activity']
  cost        0.01
  reasoning   On the activity slice, swap inter-arrival times are unusually...

GET /market/mkt-2026-09-10-006/randomness
  alpha         0.125
  draws         38
  pendingHidden False
  CLOSING ROLL  pos 19  value 0.083094936 < alpha 0.125
    hash        1545b5b07c86e03256b7bbad3bba9c7b8299fc857e0b16b6...
```

### Kalan iş

Görsel doğrulama duruyor. `pnpm demo` ile sunucu ayakta, sayfa
`http://127.0.0.1:4021/m/<marketId>` adresinde. Grafiğin gerçekten okunur
olduğu, rapor kartlarının sığdığı ve kapanış panelinin anlaşıldığı göze
bakılmadan bilinemez.

Bundle 650 kB (gzip 196 kB) — recharts'ın payı büyük. Demo için kabul
edilebilir; sıkıntı olursa grafik dinamik import'a alınabilir.

ADIM 4 (ENS spike) hâlâ açık.

---

## ADIM 30 — Settlement Görünümü

- **Tarih:** 2026-09-10
- **Durum:** KISMEN GEÇTİ — uç, tablolar ve bütçe göstergesi bitti; **görsel
  doğrulama yapılamadı** (Chrome eklentisi bağlı değil).
- **Test:** 14 yazıldı, 14 geçti
- **Tam suite:** 638/638 yeşil (4.38 sn), `pnpm -r build` temiz

### Settlement verisi hiçbir uçtan çıkmıyordu

`publicMarketView` durumu ve referansı veriyordu ama ödemeleri vermiyordu.
`GET /market/:id/settlement` eklendi: ödeme tablosu, muhasebe, transferler,
parça durumu ve bütçe sınırı.

**Market yoksa 404, varsa her zaman 200.** Henüz settle olmamış bir market
`status: 'not-settled'` dönüyor. Sayfa polling yaparken 404 toplamamalı — o,
gerçek bir hatayla karışır.

### Bütçe sınırı göstergesi

ROADMAP bunu "jüriye mekanizmanın matematiğini anladığını gösteren detay" diye
işaretlemiş ve haklı. Her prediction market ödeme tablosu gösterebilir; market
açılmadan **önce** operatörün toplam maliyetinin — birinin yazdığı bir limitle
değil, bir argümanla — sınırlandığını gösterebilen neredeyse yok.

Paper §6.2: CE-MSR ödemeleri teleskopluyor, ara fiyatlar sadeleşiyor, geriye
açılış ve kapanış kalıyor. `H(r, q_son) ≥ 0` olduğu için toplam `b·H(r, q⁰)`
ile sınırlı — market ne kadar uzarsa uzasın, fiyat ne kadar savrulursa savrulsun.

Ekran iki sayıyı yan yana koyuyor: tavan ve harcanan. Test de bunu, fiyatı her
turda 0.82 ile 0.19 arasında savuran bir transport'la zorluyor.

### Demo koşusunda öğretici bir sonuç

Gerçek veri:

```
harcanan         -0.031791
teorik tavan      0.693147
sinir icinde      True
```

Harcanan **negatif**. Market, fiyatı yanlış yöne taşıyan agent'lardan aldığını
doğru yöne taşıyanlara ödediğinden fazla toplamış; asker deposit'in skorlama
kısmını fazlasıyla geri almış. Yuvarlama artığı değil, gerçek bir sonuç. Sınır
maliyeti bağlıyor, işareti değil.

Arayüz bunu hem doğru kırpıyor (çubuk geriye gitmiyor) hem de bir cümleyle
açıklıyor — açıklamasa "%0 of the cap" tuhaf görünürdü.

### Muhasebe ekranda kapanıyor

```
giris      2099314719 tinybar
cikis      2099314719 tinybar
kapaniyor  True
```

Tam sayı olarak, kayan noktada değil. `core` agent'ları aşağı yuvarlayıp artığı
tam olarak askere veriyor, tam da bu yüzden kimlik yaklaşık değil kesin
sağlanıyor. Uç aritmetiği yayınlıyor ki okuyan yeşil bir tike güvenmek yerine
kendisi toplayabilsin.

19 ödeme satırı, 3'ü flat-fee, 7'si negatif skor. 21 transfer, 3 parça.

### Renk sadece paranın yönünü anlatıyor

Yeşil ödendi, kırmızı teminattan kesildi, gri hiç skorlanmadı. Bu ekranda
hiçbir yerde dekoratif renk yok — projeksiyondan okuyanın kimin kaybettiğini
anlamak için tek bakışı var.

### Kısmi settlement de gösteriliyor

ADIM 16 sertleştirmesinden gelen `blocked` durumu ekranda: kaç parça onaylı,
kaçının sonucu bilinmiyor, ve neden otomatik tekrar denenmediği. Plan zaten
kayıtta olduğu için ne olması gerektiği para yarım hareket etmişken de
gösterilebiliyor — testi de bunu doğruluyor.

### Kabul kriterleri

| Kriter | Durum |
|---|---|
| Muhasebe ekranda kapanıyor | EVET, tam sayı olarak, test ediliyor |
| Bütçe sınırı gösteriliyor, gerçekleşen altında | EVET, test ediliyor |
| Transfer linkleri çalışıyor | EVET (HashScan, tx id parça başına) |
| **Ekranın gerçekten doğru göründüğü** | **DOĞRULANMADI** |

### Kalan iş

Görsel doğrulama. `pnpm demo` ayakta, settled market sayfasında "Settlement"
sekmesi altında.

ADIM 29 (agent dizini) ENS'e bağlı olduğu için atlandı — ENS beklemede.

ADIM 4 (ENS spike) hâlâ açık.

---

## ADIM 20 + 21 — Agent Runner ve 20 Agent Havuzu

- **Tarih:** 2026-09-12
- **Durum:** GEÇTİ (kod + test). Canlı LLM koşusu ADIM 22 ile birlikte yapılacak.
- **Test:** 57 yazıldı, 57 geçti (14 llm + 17 runner + 14 pool + 12 server)

### PLAN SAPMASI — model sağlayıcısı

PLAN.md ve ROADMAP sabit bağlam bloğu `claude-sonnet-5` diyor. Anthropic
anahtarı yoktu, OpenAI ile koşuluyor (`gpt-4o-mini`, `OPENAI_MODEL` ile
değiştirilebilir). Mekanizma açısından fark yok: agent'tan istenen tek şey
`{ probability, reasoning }` ve hangi modelin ürettiği ne skorlamaya ne
settlement'a giriyor. Sağlayıcı tek arayüzün (`LlmClient`) arkasında, geri
dönmek tek dosya.

### Yazılanlar

| Dosya | İş |
|---|---|
| `llm.ts` | `LlmClient` arayüzü, OpenAI json_schema structured output, `parseJudgement` |
| `runner.ts` | Kanıt topla → prompt → model → davranış → ham olasılık |
| `pool.ts` | 20 agent, her birine FARKLI dilim altkümesi + persona |
| `server.ts` | `POST /report`, Hedera anahtarıyla imza, `GET /health` |

### Structured output pazarlık konusu değil

Model serbest metin dönerse olasılık ayrıştırma hatası agent çekildiği anda
oluşur, bond gider ve marketten bir rapor eksilir. Şema pinlendi. `parseJudgement`
iki gerçek vakayı REDDEDİYOR, sessizce çevirmiyor: `"0.7"` string'i ve 0-100
ölçeği. İkincisi kritik — 72 gelip 0.99'a kırpılsaydı ekranda kanaat gibi
görünürdü.

### Dilim altkümeleri: Varsayım 4'ün havuzdaki karşılığı

ROADMAP "her agent'a dilim ata" diyor. 5 dilim / 20 agent'ta naif çözüm dilim
başına 4 agent olurdu — ki bu mekanizma açısından 4 oyu olan tek agent demek.
Bunun yerine her agent FARKLI bir altküme alıyor: 5 dilimin 31 boş olmayan
altkümesi var, 20 tanesi seçiliyor, tekilller önce. Test bütün çiftleri gezip
aynı altkümeyi paylaşan agent bulursa isim vererek kırmızıya düşüyor.

32. agent istenirse `buildAgentPool` sessizce tekrar etmek yerine FIRLATIYOR.

### İmza uyumluluğu tek gerçek risktir, test edildi

Agent'ın imzası `@ethonline/api`'nin `verifyReportSignature`'ı tarafından kabul
edilmek zorunda. Kanonik mesaj kopyalanmadı, `@ethonline/api`'den import edildi:
byte-byte aynı iki kopya, biri dokunulduğu an kayar ve belirti "anahtar sorunu"
gibi görünen bir 401 olur — agent çekildiği anda, bond'u kaybederek.

Test round-trip'i doğruluyor, ayrıca imzanın HAM olasılığı kapsadığını: 0.004
raporlanıyor, kırpılmış 0.01'e karşı doğrulama BAŞARISIZ oluyor. Kırpmanın
denetlenebilir kalmasının kanıtı bu.

### Üç davranış, üç demo senaryosu

`lazy` bir öncekini TAM olarak kopyalıyor, yaklaşık değil. S_CEM(r,q,q)=log(q/q)=0
her r için; binde bir sapsa binde bir ödenirdi ve senaryo 3 sıfır yerine
"sıfıra yakın" gösterirdi. `liar` modele önce gerçekten soruyor, sonra tersini
raporluyor — marketin düzelttiği şeyin gerçek olması için.

### transport.ts düzeltmesi

`httpAgentTransport` agent'ın döndüğü `sliceIds`, `evidenceCostUsd` ve
`evidenceDigest` alanlarını düşürüyordu. `AgentReportResponse` bunları tanımlıyor
ve `app.ts` annotation olarak saklıyor, yani kanıt maliyeti arayüze hiç
ulaşmıyordu — Graph anlatısının tam ölçülebilir kısmı. Alanlar taşınıyor, ama
güvenilerek değil filtrelenerek: aynı güvenilmez kanaldan geliyorlar.

### ADIM 19 KAPANDI — dilimler canlı veride

Studio anahtarı girildi. Konu protokolü ve akranlar gateway'de tek tek
doğrulandı. Uniswap v3 ELENDİ: Messari deployment'ı `schemaVersion 4.0.0`,
diğerleri 1.3.x, ve `comparative` tek sorgu metnini hepsine gönderdiği için
major sürüm karışamaz. Balancer V2 ağda bozuk (`indexing_error`), pancakeswap-v3
tahsis edilmemiş (`no allocations`).

Seçilen: subject Curve Finance (1.3.0), akranlar Sushiswap + Bancor V3 + Saddle
+ Uniswap V2, bridge Arbitrum One Bridge (1.2.0).

```
liquidity     9/10 sinyal, 1 sorgu, $0.0100
holders      10/10 sinyal, 1 sorgu, $0.0100
activity     13/13 sinyal, 1 sorgu, $0.0100
bridge       11/11 sinyal, 1 sorgu, $0.0100
comparative  11/11 sinyal, 5 sorgu, $0.0500
[PASS] Every slice produces a distinct signal set (Assumption 4)
toplam: 9 sorgu, $0.09
```

### Flaky test düzeltildi

`app.test.ts > answers 503, not a bare 500` tam suite altında 5 sn timeout'a
takılıyordu, tek başına 349 ms'de geçiyordu. Sebep test içindeki dinamik
`import('../src/payment.js')` — @x402 paketlerini paralel worker yükü altında
süresinde çözemiyordu. Statik import'a alındı.

### Kalan iş

ADIM 22 (`POST /resolve`) ve canlı LLM koşusu. ADIM 4 (ENS spike) hâlâ açık.

---

## ADIM 22 — x402 ile Satılan Çözümleme Servisi

- **Tarih:** 2026-09-12
- **Durum:** GEÇTİ (kod + test). Canlı koşu ayrı kayıt olarak düşülecek.
- **Test:** 20 yazıldı, 20 geçti
- **Tam suite:** 711/711 yeşil (34 dosya), `pnpm -r build` temiz

### Asıl tasarım kararı: istek marketi BEKLEMİYOR

ROADMAP "istek gelince market koşar ya da cache döner" diyor. Senkron koşmak
mümkün değil: 20 bond + turlar + settlement ADIM 17'de ölçüldüğü gibi ~100 sn,
hiçbir istemci o kadar beklemez, hiçbir reverse proxy izin vermez.

| Durum | Yanıt |
|---|---|
| Soru daha önce cevaplanmış | 200, cevap + doğrulama bilgisi |
| Aynı soruya market koşuyor | 202, mevcut marketin id'si |
| Hiç market yok | 202, yeni market açıldı, izlenecek adres |

Elenen iki alternatif: isteği bloke etmek (timeout olur ve hiçbir şey için para
alınmış olur), ve arka planda market koşarken modelin tahminini satmak —
ikincisi mekanizmanın hiç üretmediği bir cevabı satmak olurdu, ki bu servisin
asla yapmaması gereken tek şey.

### Aynı soruya İKİNCİ market açılmıyor

Testlerin en önemlisi bu. İki market aynı soruda agent havuzunu bölüyor ve her
biri bilginin yarısından iki ayrı fiyat üretiyor — paper'ın eledigi paralel
market tasarımı (PLAN 6.7). Bu sisteme bir tasarım kararı olarak değil, iki
alıcının aynı soruyu saniye arayla sorması olarak sızardı. `findPendingMarket`
normalize edilmiş soru anahtarıyla bunu kapatıyor.

Soru normalizasyonu bilerek dar: büyük/küçük harf, boşluk, sondaki noktalama.
Kök bulma veya eşanlamlı eşleştirme kimsenin sormadığı bir soruya cevap satmak
olurdu ve alıcının bunu fark etme yolu yok. Test bunu da doğruluyor.

### Cevap kendi kanıtını taşıyor

`verify.hcsTopicId` + `mirrorUrl` dönüyor. Alıcı aynı diziyi public mirror
node'dan okuyup kapanış fiyatını kendi hesaplayabiliyor, bu sunucuya hiç
güvenmeden. Doğrulanamayan bir cevap bir oracle kadar değerlidir — ki bu
mekanizmanın var olma sebebi tam olarak ondan kaçınmak.

Breakdown da dönüyor: tek bir olasılık denetlenebilir değil. Sekiz agent'ın
farklı dilimlere bakıp yakınsadığını görmek, cevapla iddia arasındaki fark.

### Geçersiz test kaldırıldı, zayıflatılmadı

`app.test.ts` içindeki `POST /resolve > is declared but not built until STEP 22`
testi 501 ve "STEP 22" metni bekliyordu. ADIM 22 o stub'ı sildi, yani test artık
var olmayan bir şeyi kontrol ediyordu. Gevşetilmedi, kaldırıldı; rotanın gerçek
davranışı `test/resolve.test.ts`'te.

### TUZAK: CRLF

app.ts'i birebir metin değişimiyle yamamak ilk denemede sessizce başarısız oldu.
`.gitattributes` `* text=auto eol=lf` diyor ama çalışma ağacındaki app.ts CRLF
(785 \r). LF ile yazılmış needle eşleşmiyor. Script artık LF'e normalize edip
düzenliyor ve geldiği biçimde geri yazıyor. Script hedefi bulamayınca
`writeFileSync`'e varmadan fırlattığı için dosya bozulmadı — birebir eşleşme
kullanmanın sebebi bu.

### Uydurulan API tip kontrolüyle yakalandı

Testte `ledger.messages(topicId)` yazmıştım; `MemoryLedger`'ın yüzeyi
`topics: Map<string, HcsMessage[]>` + `all()`. Doğrulanmadan yazılmış bir
assertion'dı. `topics.get()` ile düzeltildi.

### Kalan iş

Canlı koşu: `pnpm agents` ile filo, ardından gerçek bir `POST /resolve`.
ADIM 4 (ENS spike) hâlâ açık.

---

## ADIM 20-22 CANLI KOŞU — gerçek agent'lar, gerçek kanıt

- **Tarih:** 2026-09-12
- **Durum:** GEÇTİ
- **Tam suite:** 712/712 yeşil (34 dosya)
- **Komut:** `pnpm agents` + `pnpm check:resolve`

### Ne koştu

20 agent, **ayrı süreçler**, her biri kendi Hedera anahtarıyla, kendi Graph
bütçesiyle ve kendi dilim altkümesiyle. Orchestrator onlara HTTP üzerinden
ulaştı. Bu, birim testlerin (sahte transport) ve demo sunucusunun (süreç içi
senaryolu transport) hiç kapsamadığı yapılandırma — ve tek gönderilen o.

```
[PASS] 20 agents registered, every agent published an endpoint
[PASS] Answers 202, not a guess
[PASS] Asking again points at the same market, never a second one
[PASS] 20 agents bonded (minimum 20)
[PASS] 5 reports in 23.1s, 0 timed out
       1. agent-10 P(yes)=0.2   2. agent-16 0.25   3. agent-11 0.3
       4. agent-14 0.45         5. agent-13 0.3
[PASS] Market closed (stopping-rule)
[PASS] 5 reports carried slice + cost metadata — evidence spend $0.1900
[PASS] Settled in 3 chunks, books balance: in 2099314719 = out 2099314719
[PASS] The price sold IS the terminal report — sold 0.3, terminal 0.3
[PASS] The answer carries the topic it can be checked against
```

Graph track'inin asıl iddiası burada kapanıyor: agent'lar kanıtı market
içinde satın aldı, kanıt paranın kime gideceğini belirledi, ve alıcıya
maliyeti ($0.19) cevapla birlikte bildirildi.

### TUZAK: ölü süreç portu gasp etti, koşu TAMAMEN yeşil ve TAMAMEN sahteydi

Bu, bugünün en pahalı bulgusu ve demo günü fark edilmesi imkânsıza yakındı.

Önce filoyu `--offline` (stub model) koşturdum, sonra durdurup gerçek
yapılandırmayla (OpenAI + Graph) tekrar başlattım. İkinci koşu **birinciyle
birebir aynı** çıktıyı verdi: aynı olasılıklar dört ondalık basamağa kadar,
0.1 saniye, `$0.0000` kanıt harcaması. Filo ise açılışta gururla
`Model openai:gpt-4o-mini` ve `Evidence The Graph gateway` yazıyordu.

Sebep: arka plan görevini durdurmak kabuğu öldürdü, altındaki node sürecini
değil. Eski stub agent'lar 4100-4119'da dinlemeye devam etti. Windows dışlayıcı
port bağlama uygulamadığı için yeni filo aynı portlara **hatasız** bağlandı,
20 agent'ı "registered" diye raporladı, ve istekleri eski stub'lar cevapladı.

```
PID 42836 tek basina 4100-4104'u tutuyordu
PID 31816 onun tsx sarmalayicisi
```

**Nasıl yakalandı:** stub deterministik olduğu için iki koşunun olasılıkları
birebir aynı çıktı. Gerçek bir model bunu asla yapmaz. Üç işaret birlikte
kesindi — aynı sayılar, $0 kanıt harcaması, 0.1 saniye.

**Düzeltme:** her agent sunucusu `randomUUID` ile bir `instanceId` üretiyor ve
`/health`'te yayınlıyor. Filo, portu bağladıktan sonra kendi adresine sorup
dönen kimliğin kendisininki olduğunu doğruluyor; değilse gürültülü şekilde
duruyor. Portu bağlamak ona sahip olmak demek değil.

Test de eklendi: iki sunucu farklı kimlik üretmeli ve `/health` kendi
kimliğini dönmeli.

### Yanıt süresi mekanizmanın cezası olmamalı

Orchestrator'ın varsayılanı 60 sn. Üç dilimli gerçek bir agent önce üç Graph
sorgusu yapıyor, sonra kendi timeout'u 45 sn olan bir modeli bekliyor. 60'ta
bırakmak yavaş bir sorguyu suskun agent gibi gösterirdi — ve suskun agent
teminatının tamamını kaybeder. `check:resolve` bunu 120 sn'ye çekiyor
(`REPORT_TIMEOUT_MS`). Gecikmenin bedelini kronometre değil mekanizma
kesmeli.

Gerçek koşuda 5 rapor 23.1 saniye sürdü, 0 timeout.

---

## ADIM 31 — Demo Senaryolarının Otomasyonu

- **Tarih:** 2026-09-12
- **Durum:** GEÇTİ
- **Komut:** `pnpm scenarios` (offline, deterministik) / `pnpm scenarios --real`
- **Sonuç:** 4 senaryo, 4 PASS

### Agent'lar burada süreç içinde, bilerek

`check:resolve` HTTP yolunu 20 ayrı süreçle zaten kanıtladı. Senaryoların
ihtiyacı farklı: her agent'ın neye inandığını kontrol etmek ve bunu defalarca
koşturmak. Transport gerçek `Agent` sınıfını doğrudan çağırıyor ve gerçek
anahtarla imzalıyor — mekanizma, skorlama ve settlement değişmedi, sadece
teslimat kısaldı.

### HATA: boş küme üzerinde PASS veren assertion

İlk koşuda senaryo 3 iki raporda kapandı, ikisi de flat-fee, yani skorlanan
kopyacı sayısı **sıfırdı**. `afterFirst.every(...)` boş dizide `true` döndüğü
için "EVERY ONE IS EXACTLY ZERO" yazdı ve PASS verdi. Hiçbir şey test
edilmemişti.

Bu, demonun en güçlü anının hiçbir şey kanıtlamaması demekti ve çıktıya bakan
kimse anlamazdı. Kabul koşulu artık en az 3 skorlanan kopyacı istiyor: tek
satırlık sıfır doğru ama ikna edici değil, iddia "hepsi, tam olarak sıfır".

### Yeniden deneme neden hile değil

Durma zarı gerçek, alpha=1/8 ile market ilk raporda kapanabiliyor ve
kapanıyor. Senaryo ne istediğini söylüyor, o çıkana kadar market açılıyor.
Her denemeye AYRI topic veriliyor, yani ayrı hash zinciri ve ayrı zar dizisi.
Hiçbir şey düzenlenmiyor, hiçbir zar yeniden ağırlıklandırılmıyor; elenen
marketler erken kapandı, ki bu mekanizmanın doğru çalışması.

`demo-server.ts` aynı deseni ADIM 27'de zaten kurmuştu.

### Yalancı 12. denemede tuttu — bütçe yükseltildi

Yalancının hem çekilmesi hem flat-fee kuyruğunun dışına düşmesi gerekiyor,
kabaca dörtte bir ihtimal. 12 deneme tam sınırda tuttu; bir eksik olsa senaryo
sadece şanssızlıktan FAIL raporlayacaktı. Şart gevşetilmedi, bütçe 24'e
çıkarıldı.

### Çıktılar

```
1. NORMAL          13 rapor, 10 skorlanan, fiyat 0.5448 -> 0.3513
2. YALANCI         agent-04: -0.158080639542 (scored) — kendi teminatindan odedi
3. TEOREM 7        5 skorlanan kopyaci, hepsi 0.000000000000
                   largest |payout| = 0.000e+0
4. ASKER SINIRI    harcanan -0.409266884 <= tavan 0.693147181 (b log 2)
```

Senaryo 4'te harcamanın negatif olması ADIM 30'da da görülmüştü: market fiyatı
yanlış yöne taşıyanlardan aldığını doğru yöne taşıyanlara ödediğinden fazla
topluyor. Sınır maliyeti bağlıyor, işareti değil.

### Kalan iş

ADIM 32 (README'ler), frontend görsel doğrulaması, ADIM 33 (videolar).
ADIM 4 (ENS spike) hâlâ açık.

---

## ADIM 32 — README ve Mimari

- **Tarih:** 2026-09-12
- **Durum:** KISMEN GEÇTİ — README ve mimari yazıldı, **frontend görsel
  doğrulaması hâlâ yapılamadı** (Chrome eklentisi bağlı değil).

### README İngilizce'ye çevrildi

Eskisi Türkçe'ydi ve iç kullanım içindi. Bu dosya ETHGlobal jürisinin okuyacağı
teslim artefaktı, dolayısıyla İngilizce. PLAN, ROADMAP ve bu kayıt Türkçe
kalıyor; README'den link veriliyor ve hangisinin hangi dilde olduğu belirtiliyor.

### Dürüstlük beyanları genişletildi

PLAN Bölüm 14 beş madde istiyordu (agent operasyonu, k, havuz tükenmesi,
Varsayım 4, efor). README'de dokuz madde var; dördü bugün eklendi:

| Yeni madde | Neden |
|---|---|
| ENS bu sürümde yok | Planlanmıştı, yapılmadı. Stub bile yok, iddia da yok |
| Model OpenAI, Claude değil | PLAN `claude-sonnet-5` diyordu |
| Ulaşılamayan facilitator çıplak 500 döner | `@x402/express` kütüphane sınırı |
| Transfer parçaları birbirine göre atomik değil | Hedera tek transferde hesap sayısını sınırlıyor |

Ayrıca en kolay abartılacak yer açıkça ayrıldı: **zincir seviyesindeki uçtan
uca kanıt ile 20 agent'lık koşu AYRI koşular.** Para, HCS yazımı ve settlement
gerçek Hedera testnet'inde (ADIM 17) doğrulandı; 20 agent'lık koşu ucuza
tekrarlanabilsin diye bellek-içi defter kullanıyor. İkisi de gerçek, ama
hiçbiri diğeri değil. Bunu "uçtan uca testnet'te çalışıyor" diye tek cümleye
sıkıştırmak yanlış olurdu.

### docs/architecture.md

İki mermaid diyagramı (sistem ve tur sırası), para akışı tablosu, bond'un neden
giriş ücreti değil pozisyon limiti olduğu, ve beş dilim. Tur sırası diyagramı
zarın neden yazımdan SONRA atıldığını gösteriyor — okuyan tek bakışta görsün
diye metin değil sekans olarak.

### Kalan iş

Frontend görsel doğrulaması (Chrome eklentisi gerekiyor), ADIM 33 (videolar),
ADIM 34 (submission). ADIM 4 (ENS spike) kapatılmadı ve bu sürümde
kapatılmayacak.

---

## ADIM 17+20+21+22 BİRLEŞİK — gerçek agent'lar GERÇEK ZİNCİRDE

- **Tarih:** 2026-09-12
- **Durum:** GEÇTİ
- **Komut:** `pnpm agents` + `pnpm check:orchestrator --external-agents`

### Bugüne kadar iki yarı hiç birleşmemişti

ADIM 17 zincir yarısını kanıtlıyordu (gerçek x402, gerçek HCS, gerçek HBAR
settlement) ama agent'ları bir formüldü: `p = 0.6*fiyat + 0.4*sinyal`, ne LLM
ne Graph, üstelik yirmisi tek süreçte. `check:resolve` ise agent yarısını
kanıtlıyordu (20 ayrı süreç, model, ödemeli Graph sorguları) ama bellek-içi
defterle.

İkisi de gerçekti, hiçbiri diğeri değildi. "Uçtan uca çalışıyor" cümlesi bu
repoda hiçbir şeyin arkasında durmadığı tek iddiaydı.

### Düzeltme: --external-agents

`check-orchestrator.ts` zaten gerçek zincir koşucusuydu, tek eksiği agent'ları
kendi içinde stub olarak açmasıydı. Bayrak, `startAgents` yerine filonun
4100-4119'daki endpoint'lerini kaydettiriyor. Filo da kayıt başarısızlığına
dayanıklı hale getirildi: API'ye ulaşamayınca `fetch` fırlatıp 20 dinleyen
agent'ı birden götürüyordu, ki bir filonun yapmaması gereken tam olarak bu.

### Üç koşu, üçü de zincirde

| Koşu | Topic | Sonuç |
|---|---|---|
| 1 | 0.0.10499813 | 17 rapor, 14 skorlanan, stopping-rule — **2 kontrol kırmızı** |
| 2 | 0.0.10499916 | tüm kontroller yeşil, ama ilk turda kapandı, 0 skorlanan |
| 3 | 0.0.10499955 | **7 rapor, 4 skorlanan, tüm kontroller yeşil** |

### İlk koşudaki iki kırmızı BAYAT ASSERTION'DI

`Ledger holds all 20 events — got 23` ve `Ends with market-close then
settlement`. Testi gevşetmeden önce iddiayı doğruladım:

- `settlement-chunk` `hcs-message.ts`'te birinci sınıf mesaj tipi, kendi şema
  doğrulamasıyla
- `writeChunkOutcome` her transfer parçası için bunu bilerek yazıyor; gerekçe
  yorumda: makbuzu kaybetmek denetlenebilirliğe mal olur, iki kez ödemekten
  ucuzdur
- mirror node'dan okunan zincir tam da tasarlanan dizi: 1 + 17 + 1 + 1 + 3 = 23

Yani defter doğruydu, kontrol ADIM 16 sertleştirmesinden önce yazılmıştı ve
onunla birlikte güncellenmemişti. Beklenen sayı `+ receipts.length` ile
düzeltildi, kuyruk kontrolü market-close → settlement → N× settlement-chunk
yapısını arayacak şekilde yeniden yazıldı.

Kendi yorumumda da bir hata yaptım ve düzelttim: "before and after it lands"
yazmıştım, oysa parça başına tek mesaj yazılıyor.

### Üçüncü koşunun çıktısı

```
[PASS] All 20 agents registered
[PASS] Market opened and paid for      mkt-2026-09-12-001 on 0.0.10499955
[PASS] Every bond is in the pool       20/20, hepsi x402 ile
  # 1 agent-05 p=0.816   # 2 agent-19 p=0.308   # 3 agent-02 p=0.428
  # 4 agent-17 p=0.366   # 5 agent-14 p=0.717   # 6 agent-08 p=0.375
  # 7 agent-10 p=0.309 CLOSE
[PASS] Market closed                   7 rapor, stopping-rule
[PASS] The reference is the terminal agent
[PASS] The plan balances exactly       2099314719 tinybar in and out
[PASS] All 3 transfer transactions succeeded
[PASS] The treasury is square          delta 0.00000000 HBAR
[PASS] Every agent that answered was paid   20 agents, 0 slashed
[PASS] Ledger holds all 13 events
[PASS] Ends with market-close, settlement, then one message per transfer chunk
[PASS] Consensus order is intact
ORCHESTRATOR OK — a full market ran and the books closed.
```

Asker net maliyeti 0.73778074 HBAR, iade 0.62580700 HBAR.

### Gözlem: comparative dilimi oynak olabilir

`agent-05` (yalnız `comparative`) birinci koşuda tam 0.500 (yani prior),
üçüncüde 0.816 raporladı. Aynı agent, aynı dilim, aynı subject subgraph. Soru
metni farklıydı ama bu fark tek başına açıklamıyor. Üç ihtimal: dilimin kanıtı
koşular arası oynak, model o dilimde gürültülü, ya da kanıt zayıf gelince
model prior'a yaslanıyor. Kapatılmadı, not düşüldü.

### Kalan iş

`POST /resolve` gerçek zincirde hiç koşmadı — zincir koşuları marketi
`POST /market` üzerinden açıyor. README'de madde olarak duruyor.

---

## ADIM 27 DÜZELTMESİ — arayüzden sorulan soru hiç koşmuyordu

- **Tarih:** 2026-09-12
- **Durum:** GEÇTİ
- **Bulan:** kullanıcı, demo sunucusunda `/new` sayfasından soru sorarak

### Belirti

Arayüzden sorulan soru market açıyordu ama `bonding` durumunda `bonded=0` ile
sonsuza kadar bekliyordu.

```
mkt-2026-09-12-007  [bonding]  soru: Kollektif bilinç var mı ?
    bonded=0  reports=0  price=0.5
```

### Sebep, iki kanıtla

1. **API'de bir marketi ilerleten rota yok.** On iki rotanın hiçbiri tur
   sürmüyor; turları `Orchestrator` sürüyor ve o `demo-server.ts` içinde,
   süreç içinde koşuyor. HTTP'den erişilemez.
2. **Demo agent'larının endpoint'i `demo://agent-01`.** Sahte şema. Bond HTTP'den
   atılsa bile gerçek transport oraya ulaşamaz; o adresleri yalnızca demo
   sunucusunun kendi senaryolu transport'u anlıyor.

Demo sunucusu kendi tohumladığı marketlere kendi havuzunu bağlıyordu ve
başkasınınkini izleyen hiçbir şey yoktu.

### Neden önemli

PLAN Bölüm 10, Senaryo 4 tam olarak bu: jüri kendi sorusunu sorar ve agent'ların
canlı çalışmasını izler. Soru sorma tarafının açık olmasının tek sebebi bu
senaryoydu ve arayüzdeki tek yol hiçbir yere çıkmıyordu. HTTP seviyesindeki
kontroller bunu yakalayamazdı: `POST /market` 201 dönüyor, sayfa 200 dönüyor,
her şey yeşil görünüyor.

### Düzeltme

`demo-server.ts` artık iki saniyede bir kendi store'una bakıp devralmadığı
market varsa havuzu bağlıyor ve koşturuyor. Mekanizmada hiçbir değişiklik yok:
havuz herhangi bir agent'ın kullanacağı aynı açık rotadan bond yatırıyor, market
tohumlananlarla aynı orchestrator, aynı zar ve aynı settlement'tan geçiyor.

Başarısız olan market `handled` işaretleniyor ve tekrar denenmiyor: yarım kalmış
bir marketi yeniden denemek iki kez bond yatırmak olurdu, ki bırakmaktan kötü.

### Doğrulama

```
acilan market: mkt-2026-09-12-007  topic 0.0.990007
    2s  settled   bonded=20  reports=9  price=0.4704
SONUC: settled, 9 rapor, kapanis fiyati 0.4704, sebep stopping-rule
```

Arayüzün kullandığı aynı rotadan sorulan soru iki saniyede devralındı.

### Not

Bu yalnızca demo sunucusunu ilgilendiriyor. Gerçek sunucuda (`pnpm api`) agent'lar
kendi süreçlerinde koşuyor ve marketi `check-orchestrator` ya da bir operatör
sürüyor; oraya otomatik devralma eklemek ayrı bir karar.

---

## ADIM 27 TAMAMLAMA — tarayıcı cüzdanı ve x402 ödemesi

- **Tarih:** 2026-09-12
- **Durum:** KISMEN GEÇTİ — kod, tipler ve paketleme doğrulandı; **imzalama
  turu hiç koşmadı** (tarayıcı, cüzdan ve projectId yok). Ayrıntı aşağıda.
- **Tam suite:** 712/712 yeşil, workspace build ve scripts tip kontrolü temiz

### Tasarım kısıtı: tarayıcıya private key girmez

Repodaki diğer her şey x402'yi `.env`'deki anahtarla ödüyor. Operatörün
makinesindeki script için doğru, web sayfası için imkânsız: ziyaretçiye
"private key'ini yapıştır" demek kestirme değil, yanlış ürün.

### Bunu mümkün kılan bulgu

`@x402/hedera` bir `ClientHederaSigner` alıyor ve o **düz bir nesne tipi**:

```ts
{ accountId, createPartiallySignedTransferTransaction(requirements): Promise<string> }
```

`createClientHederaSigner(accountId, privateKey)` bunun yalnızca varsayılan
üreticisi. Cüzdan destekli bir implementasyon doğrudan yerine geçiyor; şema,
facilitator ve sunucu farkı hiç görmüyor.

Cüzdan tarafı da uyuyor: `DAppSigner.signTransaction<T>(tx): Promise<T>`
imzalı **işlemin kendisini** döndürüyor, SignatureMap değil. x402 exact şeması
kısmi imzalı işlem istediği için (ücreti facilitator ödeyip zincire o
gönderiyor) bu tam olarak aranan şekil.

### İşlem kurulumu birebir eşlenmeli

Facilitator `verifyPayerSignature` ile ödeyenin **o donmuş gövdeyi** imzaladığını
doğruluyor. Bir alan bile kayarsa belirti "imza tutmadı" olur ve hata ayıklayan
kişi anahtarlara bakar, oysa sebep byte'lardır. Varsayılan imzalayıcı satır
satır eşlendi; tek fark `tx.sign(privateKey)` yerine cüzdana gidiş.

İşlem kimliğinin **facilitator'ın** hesabından üretilmesi (`TransactionId.
generate(feePayer)`) yanlış görünen ama doğru olan kısım, koda yorum düşüldü.

### TUZAK: kök barrel Reown yığınını çekiyor

`DAppConnector`'ı paket kökünden import etmek `@reown/appkit-common` çözümleme
hatası veriyor: kök barrel Reown adaptörünü de dışa veriyor. Derin yola
(`/dist/lib/dapp`) geçildi.

Bu varsayımla bırakılmadı: `lib/dapp/index.js`'ten göreli import'lar izlendi,
12 dosyaya ulaşılıyor ve harici küme tam olarak `@hiero-ledger/{proto,sdk}`,
`@walletconnect/{modal,sign-client,utils}`, `buffer`. **Reown erişilemez.**

### TUZAK: pnpm peer'ların bir kısmını kurmuş

Cüzdan paketinin kendi dizininde `@reown`, `ethers`, `@walletconnect/modal` var
ama `sign-client` ve `utils` yok, dolayısıyla bundler o dizinden çözemiyor.
Vite `resolve.alias` ile bu üç specifier uygulamanın kendi kopyalarına
yönlendirildi.

`.npmrc`'ye `shamefully-hoist` koymak da çözerdi ve **reddedildi**: tek bir
paketin paketleme hatası için bütün monorepoda çözümlemeyi gevşetmek, bir
sonrakini de gizler.

### Ödeme yığını ilk yüklemede YOK

Yığın (Hedera SDK + x402 + WalletConnect) uygulamanın kendisinden kat kat
büyük ve sayfayı açanların neredeyse hiçbiri ödeme yapmıyor. `wallet.ts`
yalnızca "Connect wallet"a basıldığında dinamik `import()` ile geliyor.

```
index-CDYxqLvS.js    664.66 kB | gzip: 200.07 kB   <- giris (taban 199 kB)
wallet-C5xS1KHf.js  3,417.54 kB | gzip: 730.64 kB   <- tembel parca
```

### Kendi hatam: taban bundle rakamını yanlış aktardım

Ölçmeden önce "mevcut bundle 89 kB gzip" dedim; o ADIM 27 kaydından kalma eski
bir sayıydı, aradan grafik ve settlement ekranı geçmiş. Gerçek taban 199 kB.
Kurduğum "dokuz katı" çerçevesi bu yüzden yanlıştı. Karar (tembel yükleme)
değişmedi, gerekçesi düzeldi.

### Diğer düzeltmeler

| Ne | Neden |
|---|---|
| `network` tipi duz `string` yerine CAIP-2 sablon tipi | `@x402/core` boyle istiyor; cast yerine kisit tasindi |
| `envDir: '../..'` | Vite env'i `apps/web`'den okur, repodaki tek `.env` kökte |
| `request()` ve `openMarket()` enjekte edilebilir fetch | Ödeme sarmalı tele ancak böyle ulaşıyor |

### DOĞRULANMAYAN — ve bu önemli

**İmzalama turu hiç koşmadı.** Derleniyor, paketleniyor, kod bölmesi çalışıyor,
imzalayıcı sözleşmesi kütüphanenin kendi tipiyle uyuşuyor, işlem kurulumu
varsayılanla eşleşiyor. Ama gerçek bir cüzdanın gerçek bir işlemi imzalayıp
facilitator'ın onu kabul ettiği **görülmedi**.

Üç şey eksik: `VITE_WALLETCONNECT_PROJECT_ID` (reown.com'dan ücretsiz), bir
tarayıcı cüzdanı (HashPack vb.) ve tarayıcıda deneme. Bunlar gelene kadar bu
madde "yazıldı" olarak durur, "çalışıyor" olarak değil.

### Kalan iş

projectId girildikten sonra tarayıcıda uçtan uca deneme. README'deki
"`POST /resolve` gerçek zincirde koşmadı" maddesi duruyor.

### TUZAK: Vite env ikamesi kose parantezle calismiyor

Kullanici cuzdani baglayamadigini soyledi. Iki sebep vardi, ikisi de benim.

**1. Degisken gercek .env'de hic yoktu.** `.env.example`'a ekledim, `.env`'e
koymayi atladim. Yani doldurulacak satir bile ortada degildi.

**2. `import.meta.env['VITE_...']` yazmistim.** Vite bu degiskenleri build
aninda duz metin ikamesiyle, **nokta erisimi** uzerinden gomuyor. Kose
parantezli yazim calisma zamani aramasi olarak kaliyor ve deger `undefined`
geliyor: kimlik girilse bile buton "unconfigured" der.

Refleksle parantez kullanmisim; oysa `noPropertyAccessFromIndexSignature` bu
repoda kapali, nokta erisimi bastan beri serbestti.

### Kendi kontrolumu yanlis okudum, duzelttim

Ilk kontrolde bundle'da `VITE_WALLETCONNECT` metnini bulup "calisma zamani
aramasi kalmis" diye hukum verdim. Bulunan sey kendi tooltip cumlemin iciydi
("Set VITE_WALLETCONNECT_PROJECT_ID in .env..."), arama degil. Hukum gecersizdi.

Kesin test sentinel ile yapildi: `.env`'e taninabilir bir deger konup build
alindi, bundle'da arandi, sonra temizlenip yeniden build edildi.

```
sentinel .env'de   -> bundle'da VAR    = ikame calisiyor
sentinel silindi   -> bundle'da YOK    = dist temiz
```

Sahte kimliği `dist`'te birakmadim: birakilsa buton "yapilandirilmis" gorunup
relay'de anlamsiz bir hatayla duserdi, ki teshisi en zor durum o.

### Kalan

projectId hala girilmedi. Girildiginde web yeniden build edilecek ve tarayicida
denenecek. O ana kadar cuzdan akisi "yazildi", "calisiyor" degil.

### Yan etki: cuzdan parcasi yalnizca kimlik doluyken uretiliyor

Nokta erisimine gecince Vite degeri build aninda gomuyor. Kimlik bos oldugunda
`if (!PROJECT_ID) return;` dalinin her zaman alindigi kanitlanabilir hale
geliyor ve sonrasindaki dinamik `import('./wallet.ts')` **olu kod** olarak
eleniyor: `dist`'te wallet parcasi hic olusmuyor.

Bu bir hata degil, dogru davranis. Ama sonucu su: cuzdan yolundaki paketleme
hatalari kimlik girilene kadar GIZLI kalir. Sentinel ile bir kez dolu deger
verilip build alindi ve parca sorunsuz uretildi:

```
index-C8DRw56K.js     664.43 kB | gzip: 199.97 kB
wallet-D-NvGdWh.js  3,417.54 kB | gzip: 730.64 kB
```

Yani cuzdan yolu build seviyesinde uctan uca dogrulandi; sentinel sonrasi
`dist` temiz build ile geri alindi.

### Kendi hatam: ANSI kodlari grep filtremi bozdu

Build ciktisini `grep -E "dist/assets"` ile filtreledim; vite ciktisinda renk
kodlari o metni escape dizileriyle boluyor, grep hicbir sey bulmayinca `&&`
zinciri kirildi ve ben build'in basarisiz oldugunu sandim. Build basariliydi.
Bugun ikinci kez bir filtre bana build hakkinda yanlis bilgi verdi.

## ADIM 27 DUZELTMESI — demo sunucusunda soru sormak bedavaydi

### Belirti

Arayuzden cuzdan baglamadan soru sorulabiliyordu ve market aciliyordu. Sebep
ortada: `pnpm demo` `createApp({ ledger })` cagiriyordu, yani `paymentGate`
enjekte edilmiyordu. Uc odemeli route'un ucu de aciktı. Bu bastan bilincli bir
tercihti (sayfalari testnet'e ve facilitator'a bagimli olmadan gelistirmek
icin) ama urunun kendisini gosterirken yanlis olan sey tam olarak buydu:
demoda mekanizmanin en gorunur kurali — soru sormak para yatirmaktir —
calismiyordu.

### Yapilan

`scripts/demo-server.ts` artik `.env`'de treasury varsa **gercek** x402
kapisini kuruyor: ayni `createPaymentGate`, ayni fiyat fonksiyonu, ayni
Blocky402 facilitator'i, ayni hesaplanmis depozito. Yani demoda gorulen 402,
gercek sunucunun gonderdigi 402.

| Karar | Neden |
| --- | --- |
| Yalniz `POST /market` kapida | Demonun 20 agent'i uydurma hesap, bakiyeleri yok; bond'u kapiya alsam market hic kosmaz. Gercek sunucuda bond'u da ayni kapi koruyor |
| Fixture'lar kapiyi atliyor | Dort ornek market sayfalar bos kalmasin diye var. Onlar da odeseydi demo, dolu bir cuzdan ve saglikli bir facilitator olmadan hic acilmazdi |
| Atlama yontemi: surece ozel rastgele header | `x-demo-fixture`, degeri `randomUUID()`. Hicbir yere yazilmiyor, basilmiyor, surecle birlikte olup gidiyor. Agdan gelen hicbir istek sunamaz |
| `--free` bayragi duruyor | Sayfa gelistirirken eski davranis hala tek komut uzakta |
| Treasury yoksa serbest mod | Ama banner bunu bagira bagira soyluyor, sessizce bedavaya dusmuyor |

### Dogrulandi

```
POST /market  odemesiz   -> HTTP 402, PAYMENT-REQUIRED basliginda 99314719 tinybar, payTo 0.0.10455276
POST /market  odemeli    -> HTTP 201, mkt-2026-09-12-007
mirror node              -> 0.0.10407814 -99314719 / 0.0.10455276 +99314719
demo log                 -> picked up mkt-2026-09-12-007, 9 rapor, kapanis 0.4704
```

Odeme operator anahtariyla yapildi, tarayici cuzdaniyla degil: amac kapinin
calistigini kanitlamakti, cuzdan yolunu degil.

### DOGRULANMAYAN

**Tarayici cuzdaniyla odeme hala denenmedi.** `VITE_WALLETCONNECT_PROJECT_ID`
bos oldugu surece 'Connect wallet' butonu acilmiyor, dolayisiyla UI'dan
odemeli market acilamiyor. Kimlik girilene kadar bu madde acik kalir.

**Demoda depozito geri donmuyor.** Para gercekten treasury'ye giriyor,
settlement ise transferleri kaydedip gondermiyor — odenecek agent'lar
uydurma. Banner bunu iki satirla soyluyor ve README'ye de limit olarak
eklendi. Paranin geri dondugu kosu `pnpm api` + `pnpm agents`.

### Yan duzeltme: .env.example yanlis LLM anahtarini istiyordu

`.env.example` `ANTHROPIC_API_KEY` yaziyordu, kod ise `OPENAI_API_KEY`
okuyor (`scripts/agent-fleet.ts`, `scripts/demo-scenarios.ts`). Repoyu
klonlayan biri dolduracak satiri bulamazdi. Degistirildi, `OPENAI_MODEL` de
eklendi, PLAN'in claude-sonnet-5 dedigi yorumda duruyor.

## ADIM 16/15 DUZELTMESI — odenmeyen bond havuza giriyordu

### Nasil ortaya cikti

Kullanici "son halini kendin test et" dedi. Iki kosu yapildi:

```
check:resolve (20 gercek agent, gercek model, gercek Graph)   HEPSI GECTI
check:orchestrator --external-agents (zincir uzerinde)        1 KONTROL DUSTU
```

Dusen kontrol:

```
[FAIL] The treasury is square    delta -2.00000000 HBAR
```

Tam 2 HBAR. Mirror node'dan sayildi:

```
hazineye giren : 18 x 1 HBAR bond + 0.99314719 deposit
hazineden cikan: 20 bond iadesi + flat fee + asker iadesi
odeyen hesaplar: 19 (1 operator + 18 agent)
odemeyenler    : agent-01, agent-15
```

agent-15'in bakiyesi tam 11.0000 HBAR: bond odemeden bond iadesi almis.

### Sebep

`@x402/express` odemeli bir route'u su sirayla kosuyor:

```
verify -> HANDLER -> yaniti tampona al -> settle -> birak veya 402
```

Handler para tasinmadan ONCE kosuyor. Settle patlayinca kutuphane tamponu
atip 402 donuyor, ama handler'in yazdigini kimse geri almiyor. Iki agent
havuza parasiz girdi, settlement ikisine de teminat iadesi odedi.

Handler 4xx donerse sorun yok: kutuphane o durumda odemeyi iptal ediyor
(`reason: handler_failed`), settle etmiyor. Tek acik "handler basarili +
settle basarisiz" hali.

Ikinci katman `check-orchestrator`'in kendi mantigiydi: `alreadyDone` sunucu
state'ini odemenin kaniti sayiyordu. Sunucu state'i odemenin kaniti degil —
en azindan bu duzeltmeden once degildi.

### Reddedilen cozum: `upfront` akisi

Hedera exact semasi `paymentFlows: { default: { supported: ['authorization',
'upfront'] } }` diyor, yani `extra: { paymentFlow: 'upfront' }` ile para
handler'dan once tasinabilir. Tek satir, ama hatayi aynasiyla degistiriyor:
odeme alinir, handler patlar, state olmaz. Kapali devre iddiasi acisindan
"fonlanmamis katilimci marketin icinde" hatasi, "hazinede sahipsiz para"dan
daha kotu ve operatorun goremedigi tek olan o. Sira aynen kaldi, etki
kosullu hale getirildi.

### Yapilan

| Dosya | Degisiklik |
| --- | --- |
| `apps/api/src/payment-rollback.ts` | yeni. Handler etkisini kaydeder, yanit 402 ise geri alir |
| `apps/api/src/payment.ts` | kapiyi `withPaymentRollback` ile sariyor, varsayilan raporlayici konsola uyari basiyor |
| `apps/api/src/app.ts` | `/market`, `/market/:id/bond` ve `/resolve` etkilerini kaydediyor |
| `packages/core/src/market.ts` | `removeBondedAgent`, yalniz bonding asamasinda |
| `apps/api/src/store.ts` | `remove(id)` ve monoton `issued` sayaci |

**Geri alma yanit gonderilmeden ONCE kosuyor.** `res.on('finish')` ile
yapmak dogru gorunuyor ve bir yaris kaybediyor: 402'yi okuyup hemen tekrar
deneyen istemci, eski bond hala kayitliyken `409 Already bonded` alir ve
bunu "demek ki odemisim" diye okur — ayni fonlanmamis agent, baska kapidan.
O yuzden `res.end` sariliyor, geri alma tek bayt yazilmadan once bitiyor.
`finish` dinleyicisi yalnizca yedek olarak duruyor.

`close` bilincli olarak kullanilmadi: baglantiyi koparan istemci odemenin
yerlesip yerlesmedigi hakkinda bir sey soylemiyor, odenmis bir bond'u
laptop kapandi diye geri almak duzeltilen hatadan daha kotu.

### Geri alinamayan sey

HCS geri alinamiyor. Deposit'i yerlesmeyen bir market, topic'inde tek bir
`market-open` mesajiyla kaliyor ve arkasi gelmiyor. Bu durum durust: topic'e
baskasi yazamaz ve okuyan kisi marketin hic kosmadigini gorur. Odenmemis bir
odemeyi anlatmak icin yeni bir mesaj tipi uydurmaktan ucuz.

Market id'leri artik `markets.size` yerine `markets.issued` uzerinden
uretiliyor; aksi halde geri alinan marketin numarasi bir sonrakine gecer ve
iki topic tek id altinda gorunurdu.

### Dogrulandi

```
8 yeni birim testi (apps/api/test/payment-rollback.test.ts)
  - deposit yerlesmezse market store'da kalmiyor
  - geri alinan market numarasini bir sonrakine devretmiyor
  - bond yerlesmezse agent havuzda kalmiyor
  - geri alinan agent odemesi yerlestiginde tekrar girebiliyor
  - odemesi yerlesen agent'larin bond'u duruyor
  - geri alma yaniti gondermeden once kosuyor  (['rolled-back','response-sent'])
  - odemesiz istekte geri alinacak bir sey yok
4 yeni core testi (removeBondedAgent)
toplam 712 -> 724, hepsi geciyor
```

Zincir uzerinde tekrar kosuldu:

```
[PASS] The treasury is square    delta 0.00000000 HBAR
topic 0.0.10503676, 2 rapor, 3 transfer, 8 mesaj
```

Dikkat: bu kosuda settle hic patlamadi, yani zincir kosusu **mutlu yolu**
dogruladi, geri alma yolunu degil. Geri alma yolu birim testleriyle
kanitlaniyor; ikisini karistirmamak lazim.

### Kalan risk

Settle'in NEDEN iki agent'ta patladigi hala bilinmiyor. 402'nin govdesi bos
geliyor, kutuphane sebebi disari vermiyor. Frekans olcusu: o kosuda 20'de 2.
Simdi en azindan bedeli yok — para gelmediyse agent havuza girmiyor ve
istemci tekrar deniyor.

## URUNUN SON HALI — market kendi kendine kosuyor, agent kendi bond'unu oduyor

Kullanici "gercek agentlarin okuyup cevap urettigi surume gecelim" dedi.
Uc parca eksikti ve ucu de "demo var, urun yok" farkiydi.

### Eksik 1 — hicbir sey marketi kosturmuyordu

`createApp` route'lari cevapliyor, `Orchestrator` bir marketi suruyor, ama
ikisini baglayan yoktu: gercek sunucuda `POST /market` ile acilan market
sonsuza kadar `bonding`'de kaliyordu. Simdiye kadar her kosuda basinda bir
script durup `closeBonding`, `runMarket` ve `settle` cagiriyordu. Demo
sunucusunda pickup dongusu vardi, urunde yoktu.

`apps/api/src/runner.ts` o dongu. Kurallari:

| Durum | Davranis |
| --- | --- |
| havuz doldu | hemen kapat ve kos, pencerenin kalanini bekleme |
| pencere doldu, havuz eksik | market iptal, deposit ve bond'lar iade |
| asker hesabi yok | market kosar, settlement YAPILMAZ, para hazinede bekler |
| kosarken hata | market oldugu yerde birakilir, tekrar denenmez |

Ucuncusu bilincli: tahmin edilen bir hesaba iade gondermek, parayi hazinede
birakmaktan kotu. Dorduncusu de: yarim kosmus marketi tekrar kosturmak
agent'lari ikinci kez ceker.

Iptal edilen market icin `buildRefundPlan` yazildi. `buildTransferPlan`'dan
ayri: o ödeme hesaplar, bu hesaplamayi reddeder. Ikisini tek fonksiyona
sokmak, mekanizmanin reddettigi bir havuzda birinin skorlanmasina giden yol.

### Eksik 2 — agent'lar kendi bond'unu odemiyordu

Simdiye kadar bond'u hep 20 anahtari birden tutan bir gate script'i odedi.
Route'un calistigini kanitliyor, urunu uretmiyor: ucuncu tarafin agent'i bunu
kendi anahtariyla yapabilmeli.

`apps/agent/src/bonding.ts`: agent API'yi izler, `decideToBond` ile karar
verir, kendi Hedera anahtariyla x402 uzerinden oder. Tavan var
(`AGENT_MAX_BOND_TINYBAR`, varsayilan 5 HBAR), cunku sarilmis fetch 402 ne
isterse oder ve bond fiyatini market aciyor. Market basina tek deneme:
yerlesmis olabilecek bir odemeyi tekrar denemek iki kez odemektir.

### Eksik 3 — gercek sunucu arayuzu servis etmiyordu

`apps/web/src/lib/api.ts` bastan beri "uretimde Express bu bundle'i servis
eder" diyordu, `server.ts` etmiyordu. Simdi ediyor: sayfalar ve odemeli API
ayni origin'de, cuzdan sayfanin geldigi host'a odeme yapiyor.

### Asker hesabi nereden geliyor

Handler odeyeni goremiyor: x402 kapisi handler'dan SONRA settle ediyor, odeyen
hesap ancak makbuzda beliriyor. Cozum: tarayici `askerAccountId` beyan ediyor,
bagli cuzdanin hesabi. Yalan soyleyenin yapabilecegi tek sey kendi iadesini
baska yere gondermek, o da tam depozito odedikten sonra. Beyan yoksa market
yine kosuyor, settlement yapilmiyor.

### TUZAK: donmus islem 120 saniyede oluyor, market onunla birlikte

Ilk canli kosuda tam bunu yedik:

```
[agent-drawn] agent-11 position 1
[runner-failed] transaction 0.0.10407814@1789228646.651958330
                failed precheck with status TRANSACTION_EXPIRED
```

`submitMessage` ve `createMarketTopic` islemi `withRetry`'in DISINDA bir kez
donduruyordu. Donmus islem sabit bir `validStart` tasiyor ve Hedera 120
saniyeden eskisini reddediyor. Pencere kapandiginda her deneme ayni cevabi
aliyor: TRANSACTION_EXPIRED, sonsuza kadar. Bir rapor yazilamayinca market
oldu, 20 bond ve deposit hazinede kaldi.

Donduran satiri retry'in icine almak gerekiyordu, ama dikkatli: sabit islem
kimligi bilerek oradaydi, cunku ilk deneme yerlesmisse ikincisi
DUPLICATE_TRANSACTION alir ve para iki kez gitmez.

Ayrim su: **suresi dolmus islem asla konsensusa ulasmamistir.** Sure
`validStart`'a gore her node'da ayni sekilde hesaplaniyor, yani dolmus islem
sonradan da gecemez. Dolayisiyla yalniz TRANSACTION_EXPIRED'de yeniden
kurmak guvenli; BUSY veya kopan baglantida donmus kimlik korunuyor.

`withFreshTransaction` bunu yapiyor, `isExpiredTransaction` durumu tanıyor,
gecerlilik suresi de 180 saniyeye (Hedera'nin izin verdigi azami) cikarildi.
TRANSACTION_EXPIRED bilincli olarak transient listesine EKLENMEDI: ayni
baytlari tekrar gondermek ise yaramaz, yeni kimlik gerekiyor.

### Dogrulandi — gercek zincirde, gercek agent'larla

```
market  mkt-2026-09-12-001  topic 0.0.10504951
  20 agent kendi bond'unu x402 ile odedi
  3 rapor: agent-12 0.1839 -> agent-19 0.1882 -> agent-18 0.3786 CLOSE
  kapanis stopping-rule, referans terminal agent
  settlement 21 satir, 3 transfer
HCS  9 mesaj: market-open, 3 report, market-close, settlement, 3 chunk
hazine  giren 2099314719 = cikan 2099314719, delta 0
```

Testler 723 -> 744.

### Askida kalan para

TRANSACTION_EXPIRED ile olen ilk market (topic 0.0.10504683) 20 bond ve bir
deposit'i hazinede birakti: 2099314719 tinybar. Sunucu bellek ici store ile
calistigi icin yeniden baslatmayla market kaydi da gitti. Iade el ile
yapilacak; hepsi ayni sahibin hesaplari arasinda ama defter kapanmadan
kapanmis sayilmaz.

## DISARIDAN AGENT — kayit imzasi ve bonding penceresi

"Kayit herkese acik" iddiasi iki yerden sizdiriyordu. Ikisi de kapatildi.

### 1. Kayit, kaydettigi anahtari tuttugunu kanitlamiyordu

`POST /agents/register` public key'i guvenle aliyordu. Para calinamazdi: bond
o hesabin imzasini gerektirir, rapor da eslesen ozel anahtari. Ama iki sey
mumkundu.

**Squat.** `agent-07` kimligini once alan, gercek agent-07'nin o ismi bir daha
kullanmasini engelliyordu, cunku kimlik ilk kayitta sabitleniyor.

**Endpoint kacirma, kotusu bu.** Yeniden kayit degistirilebilir alanlari
guncelliyor, yani biri canli bir agent'in endpoint'ini kendi sunucusuna
cevirebilirdi. Gecerli rapor uretemez — ki bu daha kotu: kurban cekilir, cevap
gelmez, butun teminatini kaybeder.

Artik kayit, kaydettigi anahtarla imzalanmak zorunda. Bu kaydi izne baglamiyor;
herkes anahtarini tuttugu her seyi kaydedebilir (PLAN 3.3). Sadece "bu anahtar
benim" iddiasi varsayim olmaktan cikip denetlenebilir hale geliyor.

Imzanin kapsami: agentId, accountId, publicKey, endpoint, dilimler ve
`issuedAt`. Degistirilebilir alanlar da iceride, cunku yalniz kimligi
imzalamak yakalanan bir imzayi surekli gecerli bir endpoint tasima ruhsatina
cevirirdi. `issuedAt` 10 dakikayla sinirli.

`signRegistration` agent paketinde: ucuncu taraf kendi agent'ini yazarken ayni
uc satiri kullaniyor, kanonik mesaj @ethonline/api'den geliyor. Iki kopya
byte-birebir bir formatta kacinilmaz olarak birbirinden ayrilir ve sonucu
anahtar sorunu gibi gorunen bir 401'dir.

### 2. Havuz pratikte disariya kapaliydi

Runner havuz `minPoolSize`'a ulasir ulasmaz bonding'i kapatiyordu. Bizim 20
agent market acildiktan saniyeler sonra bond'unu oduyor, yani disaridan biri
fiilen hic yer bulamiyordu. Kodda engel yoktu, zamanlama engeldi — ki bu daha
kotu, cunku aciklik gibi gorunuyor.

`minBondingWindowMs` eklendi, varsayilan 45 saniye. Havuz dolsa bile kapi o
sure dolmadan kapanmiyor. Sert son tarih (`bondingClosesAt`) aynen duruyor:
oraya gelindiginde havuz yeterliyse kosuyor, degilse iptal edilip iade
yapiliyor. `MIN_BONDING_WINDOW_MS=0` eski davranisi geri getiriyor.

### Dogrulandi

```
filo yeniden basladi -> 20/20 imzali kayit gecti
imzasiz kayit denemesi -> 400
sunucu banner: "Bonding: open to new agents for at least 45s per market"
7 yeni test (imza yok / baskasinin imzasi / bayat / endpoint degistirilmis;
             pencere dolmadan kapanmiyor / dolunca kosuyor / sert son tarih)
toplam 750 -> 757
```

### Kapatilmayan iki sey

**Her sey hala localhost.** API 4020'de, agent'lar 4100-4119'da. Ucuncu tarafin
gercekten katilabilmesi icin API'nin herkese acik bir adreste olmasi ve onun
endpoint'ine bizim sunucudan erisilebilmesi gerekiyor. Bu kod degil dagitim
sorunu.

**Dilimler hala beyan.** Agent `sliceIds` alanina ne yazarsa o kaydediliyor ve
hicbir sey gercekten sorgu yaptigini kanitlamiyor. Paper bunu acikca gelecek
calisma olarak isaretliyor.

## ADIM 23-26 — ENSv2: agent kimligi ve zincirde sicil

ENS bitti. Sirasiyla ne yapildi, neyin zincirde kaniti var.

### Kaynak: dokuman degil, kontratlar

ENS'in doküman sayfasinin verdigi Sepolia adresleri zincirdekiyle TUTMUYORDU.
Adresler `ensdomains/contracts-v2` reposunun kendi deployment dosyalarindan
alindi ve her biri icin `eth_getCode` ile bytecode dogrulandi. Rol sabitleri de
`RegistryRolesLib.sol` ve `PermissionedResolverLib.sol` kaynagindan okundu.

Yanlis adrese islem gondermek "izin yok" gibi gorunen bir hata uretir ve
saatler yer.

### ADIM 23 — rol semasi (docs/ens-role-schema.md)

Kod yazilmadan bitirildi, cunku isim bazinda admin rolleri YALNIZ mint aninda
verilebiliyor. En kritik karar: agent'a registry tarafinda `roleBitmap = 0`.
Ozellikle `ROLE_SET_RESOLVER` verilmiyor — verilseydi agent resolver'i kendi
kontrolundeki bir kontrata cevirip kendi skorunu yazardi ve butun iddia
coker.

Kilit bulgu: `PermissionedResolver` yetkiyi `resource(namehash, partHash(key))`
ile kapsiyor, yani ANAHTAR BAZINDA. Iki ayri resolver ya da ayri isim dali
gerekmedi.

### ADIM 24 — parent, registry, resolver

```
unverifiable.eth            8.000021 test USDC (ETH degil: register() paymentToken aliyor)
  UserRegistry proxy        0x507005f52e5F9C7ca9270E4045c9f6B53A9950Ef
  PermissionedResolver proxy 0xe45457d65a6641f2d4ce6487fc540eab81c01d6e
```

TUZAK: factory'ye islemi gonderip SONRA donus degerini okumak icin simule
ettim. Islem basariliydi ama salt tukendigi icin simulasyon revert etti ve
deploy edilen proxy'nin adresi kayboldu; islemin log'larindan kurtarildi.
Dogru sira: once simule et, o istegi gonder. Hem adres kaybolmuyor hem revert
edecek islem icin gas odenmiyor.

### Sema dogrulamasi — 20 isimden once 1 isim

`pnpm ens:spike`, 7/7 zincirde gecti:

```
[PASS] Ismin sahibi agent'in kendi Hedera anahtari
[PASS] Expiry 90 gun
[PASS] Agent kendi resolver'ini degistiremiyor      revert
[PASS] Agent ismi devredemiyor                      revert
[PASS] Agent kendi description'ini yazabiliyor      0x850add51...
[PASS] Yazdigi zincirden geri okunuyor
[PASS] Agent kendi score.net'ini yazamiyor          revert
[PASS] Orchestrator score.net'i yazabiliyor         0xd7c865b1...
```

TUZAK: simule edilmis istek baska cuzdanla gonderilemiyor. Agent'in kendi
yazma denemesi "Invalid parameters" verdi; sebep imza degil, simulasyonun
urettigi istegin simule edildigi adresi tasimasi. Izin sorunu gibi okunuyor,
degil.

### ADIM 25 — 20 subname

Her isim, agent'in Hedera anahtarindan turetilen EVM adresine mint edildi.
Ayni anahtar Hedera'da bond oduyor, HCS'e rapor imzaliyor, Sepolia'da ismi
kontrol ediyor. Kopru yok, eslestirme tablosu yok.

Mint basina iki islem: register, sonra multicall (5 anahtar bazinda yetki + 2
kayit). Yediye bir yerine ikiye bir; 140 islem yerine 40.

### ADIM 26 — sicil yazici

Settlement biter bitmez sunucu, o markete katilan her agent'in sicilini kendi
ENS ismine yaziyor. Atesle-unut: para coktan hareket etti, bu dipnot, ve yavas
bir Sepolia bir sonraki marketi bekletmemeli. Sayilar mutlak oldugu icin
basarisiz bir yazimi bir sonraki duzeltiyor.

Canli kosu: 6 raporluk market, 16 kayit yazildi, 0 hata.

```
agent-04.unverifiable.eth
  score.markets 1  score.reports 1  score.reference 1  score.net 0.100000
  hedera.account 0.0.10455281  slices bridge
```

### Kayit artik ismi zincirden dogruluyor

Anlasilan A secenegi: isim zorunlu degil, ama beyan edilirse Sepolia'dan
kontrol ediliyor — ismin sahibi, kaydi imzalayan ANAHTARIN turettigi adres mi?
Imza "bu ismi iddia ediyorum" der, kayit defteri "bu isim benim" der; ikincisi
gosterilmeye deger olan.

Canli dogrulama:

```
20/20 agent ismini dogrulatarak kaydoldu
baskasinin ismiyle kayit -> 401
  "agent-01.unverifiable.eth belongs to 0x41D6...F573, not to 0x1fd5...790e"
```

Dogrulayici enjekte ediliyor: birim testleri stub veriyor, sunucu Sepolia'ya
bakan okuyucuyu veriyor. Dogrulayicisi olmayan bir dagitim ENS ismini
tamamen reddediyor — kontrol edemedigi bir ismi gostermektense hic
gostermemek dogru.

### Okuma yolu

UniversalResolver uzerinden: `.eth` -> parent -> kendi registry'miz -> kendi
resolver'imiz. Kendi resolver adresimize kestirmeden gitmek daha hizli olurdu
ve hicbir sey kanitlamazdi — kendi veritabanini okuyan bir uygulama olurdu.

### Maliyet

0.0998 ETH ile baslandi, 0.0787 kaldi. Her sey (isim, iki deploy, spike, 20
mint, 16 sicil yazimi) 0.021 Sepolia ETH.

### Kalan

Agent'lar kendi `description`'larini yazmiyor, cunku 20 adrese gas gondermek
gerekirdi. spike-01 bunu bir kez yapti ve kanit olarak duruyor: profil
yazilabiliyor, skor yazilamiyor.

## GUVENLIK DUZELTMESI — iki acik (2026-09-13)

Teslim oncesi inceleme iki acik buldu. Ikisi de kapatildi.

### 1. `/resolve` hazineden odenmemis market aciyordu

`POST /resolve` sabit 0.1 HBAR aliyor. Cevaplanmis ya da kosan market yoksa
yeni market aciyor ve `depositTinybar`'i odenmis gibi kaydediyordu. Settlement
o depozitodan agent odemelerini ve asker iadesini hazineden yapiyordu.
Ustelik `params` govdeden geliyordu ve `b` icin ust sinir yok: `b=1000` ile
~693 HBAR'lik subvansiyon 0.1 HBAR'a aciliyordu.

Reddedilen cozum: `/resolve` fiyatini dinamik yapmak (market acilacaksa
depozito kadar). Fiyat kapida, karar handler'da veriliyor; arada kosan market
iptal olursa kapi sabit fiyat soyler, handler market acar — ayni acik, daha
dar pencereyle.

Yapilan: `/resolve` artik ASLA market acmiyor. Market yoksa 404 ve
`POST /market`'in fiyati donuyor. `@x402/express` handler durumu >= 400 ise
settlement'i `handler_failed` ile iptal ediyor (kutuphane kaynagindan
dogrulandi, `dist/esm/index.mjs`), yani bilinmeyen soru icin para cekilmiyor.
Market acmanin tek yolu depozitoyu govdeden fiyatlayan `POST /market`.

### 2. Cekilen agent orchestrator'in turunu kilitleyebiliyordu

Public `POST /market/:id/report` rotasi duruyordu. Cekilen agent orchestrator'in
HTTP istegine cevap vermek yerine bu rotaya imzali rapor gonderirse rapor
market'e giriyor, durma zari atilmiyor, `pendingAgentId` temizleniyordu.
Orchestrator'in kendi `submitReport` cagrisi sonra "Sira ... degil" diye
firlatiyor, runner `failed` deyip marketi `running`'de birakiyordu. Depozito ve
20 bond hazinede askida.

Yapilan: rota kaldirildi. Runner onu hic kullanmiyordu; raporlar yalniz
orchestrator'in istegine cevap olarak geliyor ve imza orada dogrulaniyor.

### Dogrulama

- `apps/api/test/resolve.test.ts`: bilinmeyen soru 404 ve hicbir sey acilmiyor;
  `params.b=1000` ile market acilamiyor; kosan markete 202 ile isaret ediyor.
- `apps/api/test/app.test.ts`: rapor rotasi 404, cekilen agent'in turu
  orchestrator'da kaliyor.
- `scripts/check-resolve.ts`: once 404, sonra `POST /market`, sonra 202.
