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
