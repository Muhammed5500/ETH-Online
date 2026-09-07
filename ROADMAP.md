# ROADMAP — Adım Adım Uygulama Planı

**Kullanım:** Her adımı sırasıyla Claude'a yapıştır. Her adımın başına aşağıdaki **Sabit Bağlam Bloğu**'nu ekle. Adımlar birbirine bağımlı, sırayı bozma.

**Referans:** Bu roadmap `PLAN.md` dosyasına tamamen sadıktır. Bir çelişki görürsen `PLAN.md` esastır.

---

# SABİT BAĞLAM BLOĞU

> Her adım promptunun başına bunu yapıştır.

```
PROJE BAĞLAMI

Doğrulanamayan sorular için kendi kendini çözen bir prediction market inşa ediyorum.
Teorik temel: Srinivasan, Karger, Chen — "Self-Resolving Prediction Markets for
Unverifiable Outcomes" (arXiv 2306.04305).

MEKANİZMA ÖZETİ
- Agent'lar sırayla gelir. Her agent kendi özel sinyalini VE kendinden önceki tüm
  raporları görür.
- Agent bir olasılık raporlar: q^(t) ∈ [0.01, 0.99]
- Her rapordan sonra market α olasılıkla kapanır
- Kapandığında SON agent referans agent olur, raporu r kapanış fiyatıdır
- İlk (r-k) agent cross-entropy market scoring rule ile ödenir:
    S_CEM(r, q^t, q^(t-1)) = Σ_i r_i · log( q_i^(t) / q_i^(t-1) )
- SON k agent sabit ücret R alır (arkalarında karşılaştırılacak bilgi kalmadı)
- Son k agent önceden belirlenmiş bir grup DEĞİLDİR, rastgele durma nereye denk
  gelirse orada duran son k agent'tır

NİHAİ PARAMETRELER
  N (havuz)     = 20 kayıtlı agent
  k             = 3      son 3 agent sabit ücret
  T             = 5      ortalama skorlanan agent
  α             = 1/8    her rapordan sonra kapanma olasılığı
  ε (kırpma)    = 0.01
  Beklenen market uzunluğu = 8 agent
  P(havuz tükenir) = (1-α)^(N-1) = %7.9

TEKNOLOJİ
  Dil: TypeScript, Node 20+
  Monorepo: pnpm workspaces
  Test: vitest
  Zincir 1: Hedera testnet (para + denetim izi) — @hashgraph/sdk, x402/Blocky402
  Zincir 2: Ethereum Sepolia (ENSv2 agent kimliği) — viem
  Veri: The Graph Gateway (x402 ile per-query ödeme, API key YOK)
  LLM: Anthropic SDK, agent muhakemesi için claude-sonnet-5

İHLAL EDİLMEMESİ GEREKEN KURALLAR
1. Referans HER ZAMAN terminal (son) agent. Rolling window / batch ASLA.
   (Paper Teorem 8: rolling window switching equilibrium yaratır, sonsuz ödeme,
   sınırsız zarar)
2. Raporlar [0.01, 0.99] aralığına kırpılır. log(0)=∞ saldırısı bu yüzden var.
3. Her agent bir markete EN FAZLA BİR KEZ katılır (self-dealing engeli).
4. Sıra önceden yayınlanmaz, her turda taze rastgelelikle tek tek çekilir.
5. Timeout: bond slash + listeden düş + O TUR İÇİN DURMA ZARI ATILMAZ.
6. Settlement TEK SEFERDE, market kapanmadan hiç kimseye ödeme yok.
7. Negatif CEM parası diğer agent'lara dağıtılmaz, soruyu sorana iade edilir.
8. k, T, α protokol parametresidir, hardcode edilmez.
9. Agent kaydı kodda herkese açıktır. "Bütün agent'lar bizim" varsayımı KODA
   GÖMÜLMEZ. Demo'da havuzu biz tohumluyoruz, bu bir konfigürasyon meselesi.

TEST DİSİPLİNİ — HER ADIMDA UYGULA

Bu proje adım adım inşa ediliyor ve her adım öncekinin üstüne biniyor. Bu yüzden
test kapısı zorunludur:

1. Kod yazmayı bitirince DUR. Önce o adımın testlerini yaz.
2. Testleri çalıştır: `pnpm test`
3. SADECE o adımın testleri değil, TÜM suite yeşil olmalı. Önceki adımların
   testlerinden birini kırdıysan bu bir regresyondur, düzeltmeden ilerleme.
4. `pnpm -r build` hatasız geçmeli.
5. Sonucu `docs/step-log.md`'ye kaydet.
6. Bana raporla: ne yapıldı, hangi testler yazıldı, kaçı geçti, tam suite durumu,
   kalan risk.

HERHANGİ BİR TEST KIRMIZIYSA SONRAKİ ADIMA GEÇME. Önce düzelt.

Testi geçirmek için testi zayıflatma. Test kırmızıysa kod yanlıştır; testi
gevşetmek yerine kodu düzelt. Bir testi gerçekten değiştirmen gerekiyorsa önce
bana neden gerektiğini açıkla.

Otomatik test yazılamayan adımlarda (spike, deploy, frontend, video) kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle: terminal çıktısı, explorer
linki veya ekran görüntüsü.
```

---

# TEST PROTOKOLÜ

Her adımın sonunda bir **TEST KAPISI** var. Kapı geçilmeden sonraki adıma geçilmez. Bunun sebebi projenin katmanlı olması: skorlama yanlışsa settlement yanlış olur, settlement yanlışsa zincir üstündeki transferler yanlış olur ve bunu 12. günde fark edersin.

## Test tipleri

| Tip | Nerede | Nasıl | Hangi adımlar |
|---|---|---|---|
| **Birim testi** | `packages/*/test/` | vitest, ağ yok, deterministik | 6-11, 18-19 |
| **Değişmez testi** | `packages/core/test/` | rastgele 100+ senaryo, matematiksel garanti doğrulaması | 7, 9, 11 |
| **Entegrasyon testi** | `apps/*/test/` | gerçek testnet, yavaş, ayrı komut | 15-17, 22, 24-26 |
| **Manuel doğrulama** | `docs/step-log.md` | ekran görüntüsü, explorer linki, terminal çıktısı | 2-5, 27-34 |

## Komutlar

```bash
pnpm test              # tüm birim testleri, hızlı, ağ yok — HER ADIMDA ÇALIŞIR
pnpm test:integration  # testnet gerektiren testler, yavaş
pnpm -r build          # derleme kontrolü
pnpm test:watch        # geliştirme sırasında
```

`pnpm test` **ağa çıkmamalı.** Entegrasyon testleri ayrı komutta olmalı ki her adımda saniyeler içinde tam suite koşabilesin. Ağ gerektiren şeyleri mock'la, gerçeğini `test:integration`'da doğrula.

## Değişmez testleri — bunlar kırmızıysa mekanizma bozuk

Bu üç test grubu projenin matematiksel omurgası. Kırmızı olurlarsa formülde hata var demektir, düzeltmeden hiçbir yere gidilmez.

**1. Teleskoplama (ADIM 7)**
```
Σ_t S_CEM(r, q_t, q_{t-1}) === S_CE(r, q_T) - S_CE(r, q_0)
```
Rastgele 100 rapor dizisi için geçmeli. Geçmiyorsa CE-MSR formülü yanlış.

**2. Bütçe sınırı (ADIM 7, 9)**
```
q_0 = [0.5, 0.5] iken toplam ödeme ≤ b·log(2)
```
Rastgele 100 market için geçmeli. Geçmiyorsa asker'ın maliyeti sınırsız demektir, kritik hata.

**3. Bilgisiz denge sıfır ödemesi (ADIM 11)**
```
Tüm agent'lar bir öncekini kopyalarsa → ilk agent hariç herkesin ödemesi TAM SIFIR
İlk agent → KL(r || prior)
```
Tolerans 1e-10. Bu paper Teorem 7'nin doğrudan testi ve demo videosunun en güçlü anı. Geçmiyorsa skorlama veya settlement yanlış.

## Muhasebe değişmezi — her settlement'ta

```
toplam giriş  = asker deposit + Σ agent bond'ları
toplam çıkış  = Σ agent ödemeleri + sabit ücretler + asker iadesi + iade edilen bond'lar
giriş === çıkış         (kayan nokta toleransı 1e-9)
```

Bu, ADIM 9'da birim testi olarak, ADIM 16'da entegrasyon testi olarak, ADIM 30'da ekranda gösterilecek. Üçünde de tutmalı.

## Regresyon kuralı

Her adımda **tam suite** çalışır, sadece o adımın testleri değil. 20. adımda 7. adımın testini kırdıysan bu bir regresyondur ve o an düzeltilir. Sonraki adıma taşınmaz.

## Testi zayıflatma yasağı

Test kırmızıysa kod yanlıştır. Testi gevşeterek yeşile çevirmek, hatayı bir sonraki katmana taşımaktır. Bir testin gerçekten yanlış yazıldığını düşünüyorsan önce gerekçesini yaz, sonra değiştir.

## `docs/step-log.md`

ADIM 1'de oluşturulacak ve her adımda güncellenecek. Bu dosya iki işe yarıyor: nerede kaldığını hatırlatıyor, ve 13. günde README yazarken hangi tuzaklara düştüğünü hatırlıyorsun. Sponsor README'lerindeki "ne zordu" bölümleri buradan çıkacak.

---

# FAZ 0 — KURULUM VE SPIKE'LAR (Gün 1)

Ürün kodunun tamamı üç dış bağımlılığın çalışması varsayımına dayanıyor. Hiçbir ürün kodu yazılmadan önce üçü de doğrulanacak.

---

## ADIM 1 — Monorepo İskeleti

**Amaç:** Boş ama çalışan bir monorepo kur.

**Yapılacaklar:**

Proje adını sen seç (`<PROJE_ADI>` yerine kullan). Aşağıdaki yapıyı oluştur:

```
<PROJE_ADI>/
├── package.json                 pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example
├── .gitignore
├── packages/
│   ├── core/                    SKC mekanizması, saf TS, zincirsiz
│   ├── hedera/                  Hedera SDK sarmalayıcı
│   ├── graph/                   Graph gateway client
│   └── ens/                     ENSv2 Sepolia
├── apps/
│   ├── api/                     orchestrator + x402-gated endpointler
│   ├── agent/                   agent runner
│   └── web/                     Next.js frontend
├── scripts/
└── docs/
```

**Teknik gereksinimler:**
- `pnpm-workspace.yaml`: `packages/*`, `apps/*`
- Node 20+, TypeScript 5.5+, ESM (`"type": "module"`)
- `tsconfig.base.json`: `strict: true`, `target: ES2022`, `moduleResolution: bundler`
- Her paket kendi `package.json` + `tsconfig.json` (base'i extend eder)
- vitest kök seviyede kurulu
- `.env.example` içinde şu anahtarlar (değersiz):
  ```
  HEDERA_NETWORK=testnet
  HEDERA_OPERATOR_ID=
  HEDERA_OPERATOR_KEY=
  HEDERA_TREASURY_ID=
  HEDERA_TREASURY_KEY=
  HCS_TOPIC_ID=
  BLOCKY402_FACILITATOR_URL=
  GRAPH_GATEWAY_URL=
  GRAPH_X402_PRIVATE_KEY=
  GRAPH_API_KEY=            # fallback
  SEPOLIA_RPC_URL=
  SEPOLIA_PRIVATE_KEY=
  ENS_PARENT_NAME=
  ENS_USER_REGISTRY_ADDRESS=
  ANTHROPIC_API_KEY=
  ```
- `.gitignore`: `node_modules`, `.env`, `dist`, `.next`, `agents/*.key`, `agents/accounts.json`

**Test altyapısı (bu adımda kurulacak, sonraki 33 adım buna dayanacak):**

Kök `package.json` scriptleri:
```json
{
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run --exclude '**/*.integration.test.ts'",
    "test:watch": "vitest",
    "test:integration": "vitest run '**/*.integration.test.ts'",
    "typecheck": "tsc -b --noEmit"
  }
}
```

Kurallar:
- `pnpm test` **ağa çıkmaz.** Ağ gerektiren her şey `*.integration.test.ts` uzantısıyla ayrılır ve varsayılan koşudan hariç tutulur. Amaç: tam suite'in saniyeler içinde koşabilmesi, çünkü her adımda çalıştırılacak.
- vitest workspace modunda kurulacak, tüm paketlerin testleri tek komutla koşacak
- Deterministik test için seed'li bir `RandomSource` yardımcısı `packages/core/test/helpers.ts` içinde hazır olsun

**`docs/step-log.md` oluştur.** Başlangıç içeriği:

```markdown
# Adım Kayıt Defteri

Her adımın sonunda TEST KAPISI geçildiğinde buraya kayıt düşülür.

## ADIM 1 — Monorepo İskeleti
- Tarih:
- Durum:
- Tam suite:
- Paket sürümleri:
- Tuzaklar:
```

**Kabul kriterleri (hepsi sağlanmalı):**
- `pnpm install` hatasız
- `pnpm -r build` hatasız
- `pnpm test` çalışıyor (test yok, ama komut başarılı çıkıyor)
- `pnpm typecheck` hatasız
- `docs/step-log.md` mevcut
- `.env` ve `agents/accounts.json` gitignore'da

**Dikkat:** Henüz hiçbir iş mantığı yazma. Sadece iskelet. Ama test altyapısını eksiksiz kur — sonraki 33 adımın hepsi `pnpm test` komutuna bağlı.

### TEST KAPISI — ADIM 1

**Bu kapı geçilmeden ADIM 2'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 1 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 2 — SPIKE A: Hedera x402 Hello World

**Amaç:** Hedera testnet üzerinde x402 ile ücretlendirilmiş tek bir endpoint'in uçtan uca çalıştığını kanıtla.

**Bu spike başarısız olursa proje planının yarısı değişir. Ürün koduna geçmeden önce sonuç kesinleşmeli.**

**Yapılacaklar:**

1. Hedera testnet hesabı aç (portal.hedera.com), operator ID + key'i `.env`'ye koy
2. `spikes/hedera-x402/` altında minimal bir Express server yaz:
   - `GET /paid-hello` endpoint'i x402 ile korunacak
   - Ödeme alınmadan 402 dönecek, ödeme sonrası `{ message: "ok", paidAt: ... }` dönecek
3. Aynı klasörde bir client yaz:
   - `@x402/fetch` ile wrap edilmiş fetch
   - `@x402/hedera` scheme'i register edilmiş
   - Hedera signer ile ödeme yapıp yanıtı alacak
4. Settlement bilgisini yanıt header'ından decode edip logla

**Teknik gereksinimler:**
- Blocky402 facilitator: https://blocky402.com/ — quickstart `/docs/quickstart/`
- Desteklenen ağlar: Polygon Amoy, Solana Devnet, **Hedera Testnet** (hosted testnet)
- npm paketleri: `@x402/fetch`, `@x402/core/client`, `@x402/hedera`
- Akış: server 402 döner → client Hedera signer ile kısmi imzalı tx üretir → `X-PAYMENT` header ile retry → facilitator verify + settle
- Hedera "exact payment scheme" kullanıyor (partially signed transactions)
- **Server tarafı middleware paketinin tam adını Blocky402 quickstart'ından doğrula**, bu roadmap'te varsayılmıyor

**Kabul kriterleri (hepsi sağlanmalı):**
- Ödemesiz istek 402 dönüyor
- Ödemeli istek 200 dönüyor
- HashScan'de (testnet explorer) transferi görebiliyorsun
- Terminal çıktısında settlement detayı var

**Dikkat:** Hangi token ile ödeme yapıldığını (HBAR mı, HTS stablecoin mi) not al. Sonraki adımlarda bond/deposit hesapları buna göre kurulacak.

### TEST KAPISI — ADIM 2

**Bu kapı geçilmeden ADIM 3'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 2 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 3 — SPIKE B: Graph Gateway x402 Sorgusu

**Amaç:** The Graph Gateway'e API key olmadan, x402 ile ödeyerek tek bir GraphQL sorgusu at.

**Yapılacaklar:**

1. `spikes/graph-x402/` altında minimal bir script yaz
2. Graph Gateway'e x402 ile ödeme yaparak bir subgraph sorgusu at
3. Herhangi bir Messari Standardized Subgraph seç (örn. bir DEX veya lending protokolü)
4. Basit bir sorgu çalıştır (örn. son 7 günün `financialsDailySnapshots` kayıtları)
5. Ödeme kanıtını ve sonucu logla

**Teknik gereksinimler:**
- Graph Gateway'de x402 USDC per-query **canlı**. API key, hesap veya session gerekmiyor.
- Ödeme USDC ile, HTTP üzerinden
- Gateway indexer'larla GraphTally üzerinden netleştiriyor (bizim tarafımızı ilgilendirmiyor)
- Messari Standardized Subgraph şeması: https://thegraph.com/docs/en/subgraphs/existing-subgraphs/standard-subgraphs/
- Standardize şemanın anahtar entity'leri: `Protocol`, `FinancialsDailySnapshot`, `UsageMetricsDailySnapshot`, `LiquidityPool`, `Token`

**Fallback planı:**
x402 yolu çalışmazsa Subgraph Studio API key ile devam et (`GRAPH_API_KEY`). Track hâlâ geçerli ama "agent girdisi için de öder" anlatımı zayıflar. **Bu durumda gateway client'ı iki modlu yaz** (x402 | apikey), sonradan geçiş yapılabilsin.

**Kabul kriterleri (hepsi sağlanmalı):**
- Sorgu gerçek veri dönüyor (boş array değil)
- Ödeme gerçekleşti ve loglandı
- Hangi modda çalıştığı (x402 / apikey) açıkça yazılıyor

### TEST KAPISI — ADIM 3

**Bu kapı geçilmeden ADIM 4'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 3 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 4 — SPIKE C: ENSv2 Sepolia Subname

**Amaç:** ENSv2 üzerinde kendi subname registry'ni deploy et, bir subname mint et, bir text record yaz.

**Yapılacaklar:**

1. Sepolia testnet ETH edin
2. ENS deployments repo'sundan veya ENS Discord'undan **ENSv2 Sepolia kontrat adreslerini bul** (dokümanda yok)
3. `spikes/ensv2/` altında viem ile:
   - Verifiable Factory üzerinden bir UserRegistry proxy deploy et
   - `setParent()` ile parent registry'ye bağla
   - `grantRootRoles()` ile başlangıç rollerini ver
   - `register(label, owner, registry, resolver, roleBitmap, expiry)` ile bir subname mint et
   - Bir text record yaz ve geri oku

**Teknik gereksinimler:**
- ENSv2 Permissioned Registry, her isim ERC1155Singleton token
- Roller: `ROLE_REGISTRAR`, `ROLE_SET_RESOLVER`, `ROLE_SET_SUBREGISTRY`, `ROLE_UNREGISTER`, `ROLE_RENEW`, `ROLE_CAN_TRANSFER_ADMIN`
- Her rolün admin varyantı: `role << 128`
- Docs:
  - https://docs.ens.domains/ensv2/permissioned-registry
  - https://docs.ens.domains/ensv2/permissioned-resolver
  - https://docs.ens.domains/ensv2/enhanced-access-control

**KRİTİK KISIT — bunu şimdi doğrula:**
İsim bazında **admin rolleri sadece registration anında** verilebiliyor. Registration'dan sonra sadece normal roller verilebilir. Bu spike'ta bunu deneyerek teyit et, çünkü ADIM 24'teki rol şeması buna göre tasarlanacak ve sonradan düzeltilemez.

Ayrıca rol değişiminde token id yeniden üretiliyor (eski approval'ları geçersiz kılıyor). Bunu da gözlemle.

**Kabul kriterleri (hepsi sağlanmalı):**
- Registry deploy edildi, adresi `.env`'ye yazıldı
- Bir subname mint edildi ve Sepolia explorer'da görünüyor
- Text record yazıldı ve okundu
- Admin rolü kısıtı deneysel olarak doğrulandı, sonuç not edildi

**Dikkat:** Adres bulmak muhtemelen kod yazmaktan uzun sürecek. Zaman kutusu: 3 saat. Aşarsa ENS Discord'a sor ve diğer spike'lara geç.

### TEST KAPISI — ADIM 4

**Bu kapı geçilmeden ADIM 5'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 4 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 5 — SPIKE KAPISI (Karar Noktası)

**Amaç:** Üç spike'ın sonucuna göre plana devam mı, revizyon mu karar ver.

**Yapılacaklar:**

`docs/spike-results.md` dosyası oluştur, her spike için:
- Durum: YEŞİL / SARI / KIRMIZI
- Ne çalıştı, ne çalışmadı
- Kullanılan paket sürümleri
- Karşılaşılan tuzaklar

**Karar tablosu:**

| Durum | Aksiyon |
|---|---|
| Üçü de yeşil | Plan aynen devam |
| Hedera kırmızı | **Dur.** Track değişimi konuş. Planın yarısı Hedera'ya bağlı |
| Graph sarı (x402 yok, apikey var) | Devam, gateway client iki modlu yaz, README'de belirt |
| Graph kırmızı | Track değişimi konuş |
| ENS kırmızı/sarı | Devam et, ENS en sonda ve kesilebilir parça |

**Dikkat:** Bu adımı atlama. "Sonra hallederim" diyerek ürün koduna geçmek, 10. günde track kaybetmek demek.

### TEST KAPISI — ADIM 5

**Bu kapı geçilmeden ADIM 6'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 5 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

# FAZ 1 — ÇEKİRDEK MEKANİZMA (Gün 2-3)

Zincirsiz, saf TypeScript. Bu fazın hiçbir yerinde ağ çağrısı olmayacak. Mekanizmanın doğruluğu burada testlerle kanıtlanacak, sonra zincire bağlanacak.

---

## ADIM 6 — Tipler, Konfigürasyon ve Parametre Doğrulama

**Amaç:** `packages/core` içinde temel tipleri ve parametre doğrulamasını kur.

**Yapılacaklar:**

`packages/core/src/types.ts`:

```typescript
// İkili sonuç için olasılık dağılımı. p[0] = P(Y=0), p[1] = P(Y=1), toplam 1.
export type Belief = readonly [number, number];

export interface MarketParams {
  k: number;          // sabit ücret alan son agent sayısı
  T: number;          // hedeflenen skorlanan agent sayısı
  alpha: number;      // her rapordan sonra kapanma olasılığı
  epsilon: number;    // kırpma sınırı, varsayılan 0.01
  b: number;          // likidite/ölçek parametresi (skor çarpanı)
  R: number;          // sabit ücret
  minPoolSize: number;// bonding window kapanışında gereken minimum N
  bondAmount: number;
}

export interface Report {
  agentId: string;
  position: number;       // 1-indexed
  belief: Belief;         // kırpılmış hali
  rawBelief: Belief;      // kırpma öncesi
  timestamp: number;
  evidenceRef?: string;   // HCS mesaj referansı / veri kaynağı özeti
}

export type MarketStatus =
  | 'bonding'      // agent'lar bond yatırıyor
  | 'running'      // raporlar geliyor
  | 'closed'       // durdu, settlement bekliyor
  | 'settled'
  | 'cancelled';   // N < minPoolSize, full refund

export interface MarketState {
  id: string;
  question: string;
  params: MarketParams;
  status: MarketStatus;
  prior: Belief;              // q^(0), varsayılan [0.5, 0.5]
  bondedAgents: string[];     // bond yatırmış, henüz çekilmemiş
  drawnAgents: string[];      // çekilmiş, sırayla
  reports: Report[];
  referenceReport?: Report;   // kapanışta terminal agent
  closedReason?: 'stopping-rule' | 'pool-exhausted';
}

export interface Payout {
  agentId: string;
  position: number;
  kind: 'scored' | 'flat-fee';
  amount: number;             // negatif olabilir (scored için)
  scoreRaw?: number;          // S_CEM ham değeri
}

export interface Settlement {
  marketId: string;
  reference: Belief;
  payouts: Payout[];
  totalToAgents: number;
  askerRefund: number;
  slashed: number;
}
```

`packages/core/src/config.ts`:

```typescript
export const DEFAULT_PARAMS: MarketParams = {
  k: 3,
  T: 5,
  alpha: 1 / 8,
  epsilon: 0.01,
  b: 1.0,
  R: 0.1,
  minPoolSize: 20,
  bondAmount: 1.0,
};
```

**Parametre doğrulama fonksiyonu** (`validateParams`):
- `k >= 1`
- `T >= 1`
- `0 < alpha < 1`
- `alpha` ile `1/(T+k)` arasında tutarlılık uyarısı (hata değil, uyarı)
- `0 < epsilon < 0.5`
- `minPoolSize > k + 1`
- Havuz tükenme olasılığını hesapla `(1-alpha)^(minPoolSize-1)` ve %10'u aşarsa **uyarı** ver

**Kabul kriterleri (hepsi sağlanmalı):**
- Tipler export ediliyor
- `validateParams(DEFAULT_PARAMS)` geçiyor
- Bozuk parametreler için anlamlı hata mesajları var
- Havuz tükenme uyarısı `N=8, alpha=1/8` için tetikleniyor

**Dikkat:** `Belief` her zaman iki elemanlı ve toplamı 1 olmalı. Bunu bir yardımcı ile zorla (`normalizeBelief`).

### TEST KAPISI — ADIM 6

**Bu kapı geçilmeden ADIM 7'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 6 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 7 — CE-MSR Skorlama ve Kırpma

**Amaç:** Paper'ın ödeme formüllerini birebir uygula.

**Yapılacaklar:**

`packages/core/src/scoring.ts`:

```typescript
/** Raporu [eps, 1-eps] aralığına kırpar ve yeniden normalize eder. */
export function clipBelief(b: Belief, epsilon: number): Belief;

/** Cross-entropy: H(r, q) = -Σ_i r_i log(q_i) */
export function crossEntropy(r: Belief, q: Belief): number;

/** Negatif cross-entropy skorlama kuralı: S_CE(r,q) = Σ_i r_i log(q_i) */
export function scoreCE(r: Belief, q: Belief): number;

/**
 * Cross-entropy market scoring rule:
 *   S_CEM(r, q_t, q_prev) = Σ_i r_i · log(q_t_i / q_prev_i)
 *                         = -H(r, q_t) + H(r, q_prev)
 */
export function scoreCEM(r: Belief, qT: Belief, qPrev: Belief): number;

/** KL(p || q) — bilgisiz denge testinde ilk agent'ın ödemesi için */
export function kl(p: Belief, q: Belief): number;
```

**Teknik gereksinimler:**
- Tüm log'lar doğal logaritma
- `scoreCEM` skalar çarpanı `b` ile ölçeklenir (çağıran taraf uygular, fonksiyon ham değer döndürür)
- Kırpma **girişte** yapılır, skorlama sırasında değil. Kırpılmış değerle skorlanır.
- Sıfır ve bir asla skorlama fonksiyonlarına ulaşmamalı; ulaşırsa açık hata fırlat

**Yazılacak testler:**
1. `clipBelief([0, 1], 0.01)` → `[0.01, 0.99]`
2. `clipBelief([0.5, 0.5], 0.01)` → `[0.5, 0.5]` (değişmez)
3. `scoreCEM(r, q, q)` → `0` (hareket yoksa ödeme yok)
4. `scoreCEM(r, r, qPrev) > scoreCEM(r, q, qPrev)` her `q ≠ r` için (proper scoring)
5. **Teleskoplama testi:** rastgele bir rapor dizisi için
   `Σ_t scoreCEM(r, q_t, q_{t-1}) === scoreCE(r, q_T) - scoreCE(r, q_0)`
   (kayan nokta toleransı ile)
6. **Bütçe sınırı testi:** `q_0 = [0.5, 0.5]` iken toplam ödeme `≤ log(2)` (herhangi bir `r` ve dizi için)
7. Yanlış yöne hareket negatif skor üretiyor

**Kabul kriterleri (hepsi sağlanmalı):** Yedi test de geçiyor.

**Dikkat:** 5 ve 6 numaralı testler mekanizmanın bütçe garantisini kanıtlıyor. Bunlar geçmezse ilerleme, formülde hata var demektir.

### TEST KAPISI — ADIM 7

**Bu kapı geçilmeden ADIM 8'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 7 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 8 — Market State Machine

**Amaç:** Marketin yaşam döngüsünü zincirsiz olarak uygula.

**Yapılacaklar:**

`packages/core/src/market.ts`:

```typescript
export interface RandomSource {
  /** [0,1) aralığında değer üretir. Zincir bağlanınca HCS hash'i ile değiştirilecek. */
  next(label: string): number;
}

export class Market {
  constructor(state: MarketState, rng: RandomSource);

  /** Bonding aşamasında agent ekler. Aynı agent iki kez eklenemez. */
  addBondedAgent(agentId: string): void;

  /**
   * Bonding window'u kapatır.
   * N < minPoolSize ise status = 'cancelled' (full refund).
   * Aksi halde status = 'running'.
   */
  closeBonding(): void;

  /**
   * Sıradaki agent'ı çeker. Kalan bond'lu agent'lardan taze rastgelelikle.
   * Sırayı ÖNCEDEN hesaplamaz, her çağrıda tek agent çeker.
   */
  drawNextAgent(): string | null;

  /** Çekilen agent'ın raporunu kaydeder. Kırpma burada uygulanır. */
  submitReport(agentId: string, rawBelief: Belief): Report;

  /**
   * Rapordan SONRA çağrılır. alpha olasılıkla marketi kapatır.
   * Havuz tükendiyse zorla kapatır (closedReason = 'pool-exhausted').
   */
  rollStoppingDice(): boolean;

  /**
   * Agent zamanında cevap veremedi.
   * Bond slash + listeden düş. DURMA ZARI ATILMAZ.
   */
  handleTimeout(agentId: string): void;

  /** Marketin şu anki fiyatı: son rapor, yoksa prior. */
  currentPrice(): Belief;

  getState(): Readonly<MarketState>;
}
```

**Davranış kuralları (kodda zorla):**
1. `drawNextAgent` sadece `status === 'running'` iken çalışır
2. Çekilen agent `bondedAgents`'tan çıkarılır, `drawnAgents`'a eklenir → **aynı agent asla iki kez çekilemez**
3. `submitReport` sadece o an çekilmiş agent'tan kabul edilir
4. `rollStoppingDice` sadece bir rapordan hemen sonra çağrılabilir
5. `bondedAgents` boşaldıysa ve market hâlâ açıksa → zorla kapat, `closedReason = 'pool-exhausted'`
6. Kapanışta `referenceReport = reports[reports.length - 1]`
7. `handleTimeout` durma zarını **atlar**

**Yazılacak testler:**
1. Aynı agent iki kez çekilmiyor
2. `N < minPoolSize` → cancelled
3. Timeout durma zarını tetiklemiyor (deterministik RNG ile doğrula)
4. Havuz tükenince zorla kapanıyor ve `closedReason` doğru
5. `alpha = 1` ile market tam olarak 1 rapordan sonra kapanıyor
6. `alpha = 0` ve `N = 20` ile market tam 20 rapordan sonra tükenerek kapanıyor
7. Referans her zaman son rapor

**Kabul kriterleri (hepsi sağlanmalı):** Yedi test de geçiyor. Deterministik `RandomSource` (seed'li) ile testler tekrarlanabilir.

### TEST KAPISI — ADIM 8

**Bu kapı geçilmeden ADIM 9'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 8 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 9 — Settlement Hesaplayıcı

**Amaç:** Kapanmış bir marketten ödemeleri hesapla ve bütçe değişmezlerini doğrula.

**Yapılacaklar:**

`packages/core/src/settlement.ts`:

```typescript
export function computeSettlement(state: MarketState): Settlement;

/** Soru soranın yatırması gereken minimum deposit: b·log2 + k·R */
export function requiredDeposit(params: MarketParams, prior: Belief): number;
```

**Hesaplama mantığı:**

```
r = referenceReport.belief
n = reports.length
scoredCount = max(0, n - k)

Agent'lar 1..scoredCount:
  kind = 'scored'
  amount = b · S_CEM(r, q^(t), q^(t-1))     q^(0) = prior
  (t = 1 için q^(t-1) = prior)

Agent'lar (scoredCount+1)..n:
  kind = 'flat-fee'
  amount = R

totalToAgents = Σ payouts.amount
slashed       = Σ |amount| , amount < 0 olanlar
askerRefund   = deposit - Σ(pozitif ödemeler) + slashed
```

**Zorlanacak değişmezler (kod içinde assert):**
1. `Σ scored payouts ≤ b · H(r, prior)` — teleskoplama sınırı
2. `flat-fee` alan agent sayısı `= min(k, n)`
3. Hiçbir negatif ödeme başka bir agent'a aktarılmıyor (`slashed` sadece `askerRefund`'a ekleniyor)
4. `totalToAgents + askerRefund === deposit + slashed` (muhasebe kapanıyor)
5. Her agent'ın negatif ödemesi `bondAmount`'u aşamaz — aşarsa `bondAmount`'ta kırp ve uyarı logla

**Yazılacak testler:**
1. Bütçe sınırı hiçbir rastgele senaryoda aşılmıyor (100 rastgele market simüle et)
2. Muhasebe her zaman kapanıyor
3. `n <= k` durumunda herkes flat-fee alıyor
4. Negatif ödeme bond'u aşarsa kırpılıyor
5. `requiredDeposit` doğru hesaplıyor

**Kabul kriterleri (hepsi sağlanmalı):** Beş test de geçiyor.

**Dikkat:** 3 numaralı değişmez (negatif para agent'lara dağıtılmaz) hukuki/tasarımsal bir karar, teknik bir detay değil. Kod içinde yorumla belirt.

### TEST KAPISI — ADIM 9

**Bu kapı geçilmeden ADIM 10'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 9 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 10 — k Hesaplayıcı (Teorem 1 ve Teorem 4)

**Amaç:** Paper'ın k formüllerini uygula. Bu, README'de savunma zeminimiz olacak.

**Yapılacaklar:**

`packages/core/src/kcalc.ts`:

```typescript
/**
 * Teorem 1, sapma sınırı:
 *   |Δ| ≤ (1/4)·((1-η)/η - η/(1-η))·(1-δ)^k
 */
export function deviationBound(delta: number, eta: number, k: number): number;

/**
 * Teorem 1, Denklem 3 — ε'-yaklaşık k:
 *   k ≥ (1/-log(1-δ))·log( (1/(4ε'))·((1-η)/η - η/(1-η)) )
 */
export function kMinApprox(delta: number, eta: number, epsilonPrime: number): number;

/**
 * Teorem 4, Denklem 7 — strict truthfulness (τ gerektirir):
 *   k > (1/-log(1-δ))·log( |log((1-η)/η)|·((1-η)/η - η/(1-η)) / (8·(τ·η·(1-η))²) )
 */
export function kMinStrict(delta: number, eta: number, tau: number): number;

/** Sonlu havuzda tükenme olasılığı: (1-α)^(N-1) */
export function poolExhaustionProbability(alpha: number, N: number): number;

/** Bir agent'ın sabit ücret alma olasılığı: 1-(1-α)^k */
export function flatFeeProbability(alpha: number, k: number): number;
```

**Ayrıca bir CLI aracı yaz:** `scripts/kcalc.ts`

Çalıştırıldığında şu tabloları basar:
- `kMinApprox` için δ ∈ {0.5, 0.3, 0.2, 0.1} × η ∈ {0.2, 0.1, 0.05} × ε ∈ {0.1, 0.05, 0.01}
- `kMinStrict` için δ × η × τ ∈ {1.0, 0.5, 0.2}
- N=20 için k/T/α seçenek tablosu ve her birinin tükenme olasılığı

**Doğrulama değerleri (bu sayılar tutmalı):**

| δ | η | ε | kMinApprox |
|---|---|---|---|
| 0.5 | 0.1 | 0.05 | ≈ 5.5 |
| 0.3 | 0.1 | 0.05 | ≈ 10.6 |
| 0.2 | 0.1 | 0.05 | ≈ 17.0 |

| δ | η | k | deviationBound |
|---|---|---|---|
| 0.5 | 0.1 | 3 | ≈ 0.278 |
| 0.5 | 0.1 | 4 | ≈ 0.139 |
| 0.5 | 0.1 | 6 | ≈ 0.035 |

`poolExhaustionProbability(1/8, 20)` ≈ 0.079

**Kabul kriterleri (hepsi sağlanmalı):** Yukarıdaki değerler ±0.05 toleransla üretiliyor. CLI çalışıyor.

**Dikkat:** Bu araç README'ye girecek. "k=3 seçtik çünkü hesaplayıcı bunu diyor" değil, "hesaplayıcı k≈6 diyor, biz 20 agent'lık havuzla çalışabilirlik için 3 ile koşuyoruz ve bunu belgeliyoruz" anlatımı kurulacak.

### TEST KAPISI — ADIM 10

**Bu kapı geçilmeden ADIM 11'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 10 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 11 — Simülasyon Harness'ı ve Üç Senaryo

**Amaç:** Mekanizmanın üç davranışını zincirsiz olarak kanıtla. Bunlar demo senaryolarının test karşılığı.

**Yapılacaklar:**

`packages/core/src/simulate.ts`:

```typescript
export interface SimAgent {
  id: string;
  /** Önceki raporları ve kendi sinyalini görüp bir inanç üretir. */
  report(history: Report[], prior: Belief): Belief;
}

export function simulateMarket(
  params: MarketParams,
  agents: SimAgent[],
  prior: Belief,
  seed: number
): { state: MarketState; settlement: Settlement };
```

**Üç senaryo agent'ı yaz:**

**1. Dürüst agent (`makeHonestAgent`)**
- Gizli bir "gerçek" değer etrafında gürültülü sinyal alır
- Önceki raporları Bayesçi olarak birleştirir (basit ağırlıklı ortalama yeterli)
- Sonucu raporlar

**2. Yalancı agent (`makeLiarAgent`)**
- Dürüst inancını hesaplar, sonra tersini raporlar (`[p1, p0]`)

**3. Tembel agent (`makeLazyAgent`)**
- Bir önceki raporu birebir kopyalar
- İlk agent ise prior'ı raporlar

**Yazılacak testler:**

1. **Senaryo Normal:** 20 dürüst agent → fiyat gerçek değere yakınsıyor, ödemelerin toplamı bütçe sınırı içinde
2. **Senaryo Yalancı:** 19 dürüst + 1 yalancı → yalancı agent'ın ödemesi **negatif**, dürüstlerin ortalaması pozitif
3. **Senaryo Tembel (KRİTİK):** hepsi tembel → **ilk agent hariç herkesin ödemesi tam olarak 0**
   - Paper Teorem 7'nin doğrudan testi
   - İlk agent `KL(r || prior)` alıyor, bunu da doğrula
4. Karma: 10 dürüst + 5 yalancı + 5 tembel → dürüstlerin ortalama ödemesi en yüksek

**Kabul kriterleri (hepsi sağlanmalı):** Dört test de geçiyor. Özellikle 3 numaralı test **tam sıfır** vermeli (kayan nokta toleransı 1e-10).

**Dikkat:** Test 3 videodaki en güçlü anın matematiksel karşılığı. Geçmezse skorlama veya settlement'ta hata var.

### TEST KAPISI — ADIM 11

**Bu kapı geçilmeden ADIM 12'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 11 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

# FAZ 2 — HEDERA ENTEGRASYONU (Gün 4-6)

**Mimari kararı: Para yolunda Solidity YOK.**

Gerekçe: settlement matematiği `Σ r_i log(q_i/q_{i-1})` içeriyor. Bunu Solidity'de sabit noktalı logaritma ile yapmak günler alır ve hiçbir fayda sağlamaz. Bunun yerine:
- Para hareketi: x402 (giriş) + Hedera SDK transfer (çıkış), operatör treasury hesabı üzerinden
- Denetlenebilirlik: her rapor ve her ödeme HCS'e yazılır, tüm defter herkesçe doğrulanabilir ve yeniden hesaplanabilir

Bu, custody'nin v1'de operatörde olduğu anlamına gelir. README'de açıkça belirtilecek (bkz. ADIM 32).

---

## ADIM 12 — Hedera Hesap Altyapısı

**Amaç:** Treasury ve 20 agent hesabını oluştur, yönet.

**Yapılacaklar:**

`packages/hedera/src/client.ts`:
- `@hashgraph/sdk` ile testnet client factory
- Operator kimlik bilgilerini `.env`'den alır
- Retry + timeout sarmalayıcısı

`packages/hedera/src/accounts.ts`:
- `createAccount(initialBalance)` → yeni hesap + private key
- `getBalance(accountId)`
- `transfer(from, to, amount, memo)`

`scripts/setup-hedera-accounts.ts`:
- Treasury hesabı oluştur (yoksa)
- 20 agent hesabı oluştur
- Her birine test HBAR fonla
- Sonucu `agents/accounts.json` dosyasına yaz:
  ```json
  [{ "agentId": "agent-01", "accountId": "0.0.xxxx", "privateKey": "..." }]
  ```
- **Bu dosya `.gitignore`'da olmalı**

**Kabul kriterleri (hepsi sağlanmalı):**
- Script çalışıyor, 20 hesap oluşuyor
- Her hesabın bakiyesi HashScan'de görülebiliyor
- `accounts.json` üretiliyor ve git'e girmiyor

**Dikkat:** Agent hesap sayısı konfigürasyondan gelsin (`AGENT_COUNT=20`), hardcode etme. Bu, "havuz bizim" varsayımını koda gömmeme kuralının bir parçası.

### TEST KAPISI — ADIM 12

**Bu kapı geçilmeden ADIM 13'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 12 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 13 — HCS Rapor Defteri

**Amaç:** Her raporu Hedera Consensus Service'e yaz. Bu, SKC'nin denge ispatının dayandığı sıralı ve değiştirilemez geçmişi sağlıyor.

**Bağlam:** SKC'nin denge ispatı her agent'ın kendinden önceki TÜM raporları görmesine ve sıranın manipüle edilememesine dayanıyor. HCS consensus timestamp'i tam olarak bunu veriyor. Bu süs değil, mekanizmanın gereksinimi.

**Yapılacaklar:**

`packages/hedera/src/hcs.ts`:

```typescript
/** Yeni bir market için topic oluşturur. */
export async function createMarketTopic(memo: string): Promise<string>;

/** Bir mesajı topic'e yazar. Consensus timestamp ve running hash döner. */
export async function submitMessage(
  topicId: string,
  payload: object
): Promise<{ sequenceNumber: number; consensusTimestamp: string; runningHash: Uint8Array }>;

/** Topic'teki tüm mesajları sırayla okur. */
export async function readTopicMessages(topicId: string): Promise<HcsMessage[]>;
```

**Mesaj şeması (JSON, versiyonlu):**

```json
{
  "v": 1,
  "type": "report" | "market-open" | "market-close" | "settlement" | "timeout",
  "marketId": "...",
  "position": 3,
  "agentId": "agent-07",
  "belief": [0.28, 0.72],
  "rawBelief": [0.28, 0.72],
  "evidenceDigest": "sha256:...",
  "ts": 1234567890
}
```

**Kabul kriterleri (hepsi sağlanmalı):**
- Topic oluşuyor
- Mesaj yazılıyor, running hash dönüyor
- Mesajlar geri okunuyor ve sıra korunuyor
- HashScan'de topic mesajları görünüyor

**Dikkat:** Running hash'i `submitMessage` yanıtından alman lazım, sonraki adımda rastgelelik kaynağı olacak. Alamıyorsan mirror node'dan çek.

### TEST KAPISI — ADIM 13

**Bu kapı geçilmeden ADIM 14'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 13 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 14 — HCS Running Hash'ten Rastgelelik

**Amaç:** Durma zarını doğrulanabilir bir kaynaktan türet.

**Bağlam:** Rapor gönderilmeden önce running hash tahmin edilemiyor, gönderildikten sonra herkes doğrulayabiliyor. Orchestrator'ın durma kararını manipüle etmesini engelliyor.

**Yapılacaklar:**

`packages/hedera/src/randomness.ts`:

```typescript
/**
 * HCS running hash'ini [0,1) aralığında bir sayıya çevirir.
 * İlk 8 byte'ı big-endian uint64 olarak alıp 2^64'e böler.
 */
export function hashToUnitInterval(runningHash: Uint8Array): number;

/** core'daki RandomSource arayüzünü HCS ile implemente eder. */
export class HcsRandomSource implements RandomSource { ... }

/**
 * Bir durma kararını sonradan doğrular.
 * Herkes bunu çalıştırıp kapanışın adil olduğunu teyit edebilir.
 */
export function verifyStoppingDecision(
  runningHash: Uint8Array,
  alpha: number,
  didStop: boolean
): boolean;
```

**Karar kuralı:**
```
u = hashToUnitInterval(runningHash)
didStop = (u < alpha)
```

**Kabul kriterleri (hepsi sağlanmalı):**
- `hashToUnitInterval` uniform dağılım üretiyor (10.000 rastgele hash ile ki-kare testi)
- `verifyStoppingDecision` doğru/yanlış ayrımını yapıyor
- Aynı hash her zaman aynı sonucu veriyor (deterministik)

**Dikkat:** Production'da uygun bir VRF veya drand önerilecek. README'de not düş: agent teorik olarak mesaj içeriğini değiştirerek hash'i grind edebilir, ama consensus timestamp içerdiği için pratikte zor. Bu bir demo kısıtı.

### TEST KAPISI — ADIM 14

**Bu kapı geçilmeden ADIM 15'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 14 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 15 — x402 ile Korunan API Endpointleri

**Amaç:** Para girişini x402 üzerinden al.

**Yapılacaklar:**

`apps/api` içinde Express server:

**Korumalı endpointler (x402 gated):**

```
POST /market
  body: { question, params?, priorBelief? }
  ödeme: deposit (requiredDeposit ile hesaplanan minimum)
  yanıt: { marketId, topicId, bondingClosesAt, params }

POST /market/:id/bond
  body: { agentId }
  ödeme: bondAmount
  yanıt: { position: null, bondedCount: N }

POST /resolve
  body: { question, contextHints? }
  ödeme: sabit servis ücreti
  yanıt: { probability, confidence, marketId, reportCount }
  NOT: Bu, Hedera track'inin istediği "satılabilir servis". ADIM 22'de doldurulacak.
```

**Korumasız endpointler:**

```
GET  /market/:id            market durumu (public)
GET  /market/:id/reports    rapor geçmişi (public)
GET  /markets               market listesi
POST /market/:id/report     agent raporu (imza ile doğrulanır, ödeme yok)
GET  /agents                kayıtlı agent listesi
POST /agents/register       agent kaydı (HERKESE AÇIK)
```

**SPIKE A'DA DOĞRULANMIŞ GERÇEKLER — tahmin etme, bunları kullan:**

```ts
// SERVER
import { paymentMiddlewareFromConfig } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import { HBAR_ASSET_ID, HEDERA_TESTNET_CAIP2 } from '@x402/hedera';

const facilitator = new HTTPFacilitatorClient({ url: 'https://api.testnet.blocky402.com' });
const routes = {
  'POST /market': {
    accepts: { scheme: 'exact', network: HEDERA_TESTNET_CAIP2, payTo: TREASURY_ID,
               price: { asset: HBAR_ASSET_ID, amount: '<tinybar>' } },
  },
};
app.use(paymentMiddlewareFromConfig(routes, facilitator,
  [{ network: HEDERA_TESTNET_CAIP2, server: new ExactHederaScheme() }]));

// CLIENT
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import { createClientHederaSigner, ExactHederaScheme, PrivateKey } from '@x402/hedera';

const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(key),
                                        { network: HEDERA_TESTNET_CAIP2 });
const client = x402Client.fromConfig({
  schemes: [{ network: HEDERA_TESTNET_CAIP2, client: new ExactHederaScheme(signer) }],
  spendControls: { allowedAssets: [{ network: HEDERA_TESTNET_CAIP2, asset: HBAR_ASSET_ID,
                                     maxAmountPerPayment: '10000000' }] },
});
const res = await wrapFetchWithPayment(fetch, client)(url);
const settlement = decodePaymentResponseHeader(res.headers.get('payment-response')!);
```

**Üç tuzak (SPIKE A'da her biri zaman yedi):**

1. **Settlement header'ının adı `payment-response`**, `x-payment-response` DEĞİL.
   Yanlış isim kullanırsan header boş döner ve ödeme başarısız sanırsın — oysa ödeme
   başarılıdır.
2. **Harcama kontrolleri HBAR'ı varsayılan olarak reddediyor.** `spendControls` içinde
   `allowedAssets` ile açıkça izin ver. `false` ile kapatma — bu özellik ADIM 20'de
   agent'ların harcamasını sınırlamak için işine yarayacak.
3. **`pnpm --filter X <script>` pnpm'in yerleşik komutlarıyla çakışıyor.** Her zaman
   `pnpm --filter X run <script>` kullan.

**Paket sürümleri:** `@x402/*` **2.25.0**. `x402` / `x402-express` v1.2.0 eski hat, kullanma.

**Teknik gereksinimler:**
- x402 middleware'ini Blocky402 quickstart'a göre kur (ADIM 2'de doğrulanmıştı)
- Ödeme doğrulandıktan sonra iş mantığı çalışsın, önce değil
- Ödeme miktarı endpoint bazında dinamik olmalı (`/market` deposit'i parametreye bağlı)
- Her başarılı ödemenin settlement bilgisi loglansın ve HCS'e yazılsın

**Kabul kriterleri (hepsi sağlanmalı):**
- Ödemesiz istek 402
- Ödemeli istek iş mantığını çalıştırıyor
- `POST /market` gerçek bir market ve HCS topic'i yaratıyor
- `POST /market/:id/bond` agent'ı havuza ekliyor
- Yetersiz deposit ile market açılamıyor

### TEST KAPISI — ADIM 15

**Bu kapı geçilmeden ADIM 16'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 15 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 16 — Orchestrator ve Ödeme Yürütücü

**Amaç:** Market yaşam döngüsünü zincirle birlikte sür.

**Yapılacaklar:**

`apps/api/src/orchestrator.ts`:

```typescript
class Orchestrator {
  /** Bonding window süresi dolunca çağrılır. */
  async closeBonding(marketId: string): Promise<void>;

  /** Bir tur çalıştırır: agent çek → cevap iste → HCS'e yaz → durma zarı at */
  async runRound(marketId: string): Promise<RoundResult>;

  /** Market kapanana kadar tur döndürür. */
  async runMarket(marketId: string): Promise<void>;

  /** Kapanmış marketi settle eder ve transferleri yapar. */
  async settle(marketId: string): Promise<Settlement>;
}
```

**Tur akışı (sırayı bozma):**
```
1. market.drawNextAgent()  → agentId
2. Agent'ın endpoint'ine istek at, timeout ile (varsayılan 60sn)
3a. Cevap geldi:
    - market.submitReport(agentId, belief)
    - HCS'e "report" mesajı yaz → runningHash al
    - runningHash'ten durma zarı at
    - Kapandıysa HCS'e "market-close" yaz
3b. Timeout:
    - market.handleTimeout(agentId)
    - HCS'e "timeout" mesajı yaz
    - DURMA ZARI ATMA
4. Havuz boşaldıysa zorla kapat
```

**Settlement akışı:**
```
1. computeSettlement(state)
2. HCS'e "settlement" mesajı yaz (tüm ödemeler dahil)
3. Her agent için treasury'den transfer:
   - Pozitif ödeme: treasury → agent (bond iadesi + kazanç)
   - Negatif ödeme: bond'dan kesinti, kalan iade
   - Flat-fee: treasury → agent (bond iadesi + R)
4. Kalan deposit + slash edilen para → asker'a iade
5. Muhasebe kontrolü: toplam çıkış === toplam giriş
```

**Kabul kriterleri (hepsi sağlanmalı):**
- Uçtan uca bir market çalışıyor (sahte agent'larla)
- HCS'te tüm olaylar sırayla görünüyor
- Transferler HashScan'de doğrulanabiliyor
- Muhasebe kapanıyor, hata payı yok

**Dikkat:** `runRound` içindeki sıra kritik. Durma zarı raporun HCS'e yazılmasından SONRA atılmalı, çünkü rastgelelik o raporun hash'inden geliyor.

### TEST KAPISI — ADIM 16

**Bu kapı geçilmeden ADIM 17'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 16 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 17 — Hedera Uçtan Uca Entegrasyon Testi

**Amaç:** Faz 2'yi kilitle.

**Yapılacaklar:**

`apps/api/test/e2e-hedera.test.ts`:

Testnet üzerinde gerçek bir market koştur:
1. Asker deposit'i x402 ile öder, market açılır
2. 20 sahte agent bond yatırır
3. Bonding kapanır
4. Turlar çalışır, sahte agent'lar rastgele inanç döner
5. Market kapanır
6. Settlement yürütülür
7. Tüm bakiyeler kontrol edilir

**Ayrıca doğrula:**
- HCS mesaj sayısı = rapor sayısı + 3 (open, close, settlement)
- Her durma kararı `verifyStoppingDecision` ile doğrulanabiliyor
- Timeout senaryosu: bir agent'ı kasten cevap vermeyecek yap, durma zarının atlanmadığını doğrula

**Kabul kriterleri (hepsi sağlanmalı):** Test testnet'te uçtan uca geçiyor. Süre 5 dakikayı aşmıyor.

### TEST KAPISI — ADIM 17

**Bu kapı geçilmeden ADIM 18'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 17 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

# FAZ 3 — THE GRAPH ENTEGRASYONU (Gün 7-8)

---

## ADIM 18 — Graph Gateway Client

**Amaç:** Agent'ların kanıt kaynağını kur.

**Yapılacaklar:**

`packages/graph/src/gateway.ts`:

```typescript
export type GatewayMode = 'x402' | 'apikey';

export class GraphGateway {
  constructor(config: { mode: GatewayMode; ... });

  /** Bir subgraph deployment'ına GraphQL sorgusu atar, ödeme yapar. */
  async query<T>(
    subgraphId: string,
    query: string,
    variables?: Record<string, unknown>
  ): Promise<{ data: T; paymentProof?: string; costUsd?: number }>;
}
```

**Teknik gereksinimler:**
- x402 modunda: API key yok, ödeme HTTP üzerinden USDC
- apikey modunda: `Authorization` header ile Studio key (fallback)
- Her sorgunun maliyeti kaydedilsin (agent'ın "girdisi için ödediği" rakam demoda gösterilecek)
- Sorgu hataları anlamlı şekilde sarmalansın
- Rate limit'e karşı basit retry + backoff

**Kabul kriterleri (hepsi sağlanmalı):**
- Her iki modda da sorgu çalışıyor
- Maliyet raporlanıyor
- Mod `.env`'den seçilebiliyor

### TEST KAPISI — ADIM 18

**Bu kapı geçilmeden ADIM 19'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 18 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 19 — Veri Dilimleri (Data Slices)

**Amaç:** Her agent'ın farklı bir veri görünümüne bakmasını sağla.

**Bağlam — bu adım kozmetik değil:** Paper'ın Varsayım 4'ü agent sinyallerinin sonuç verildiğinde koşullu bağımsız olmasını gerektiriyor. 20 agent aynı veriye bakarsa bu varsayım çöker, δ → 1'e gider, gereken k patlar. Veri dilimi ayrıştırması mekanizmanın çalışma şartı.

**Yapılacaklar:**

`packages/graph/src/slices.ts`:

```typescript
export interface DataSlice {
  id: string;
  name: string;
  description: string;
  /** Soru bağlamından bu dilime ait kanıtı çeker. */
  fetch(gateway: GraphGateway, ctx: QuestionContext): Promise<SliceEvidence>;
}

export interface SliceEvidence {
  sliceId: string;
  summary: string;              // LLM'e verilecek insan-okunur özet
  raw: unknown;                 // ham veri
  queryCostUsd: number;
  sources: string[];            // subgraph id'leri
}
```

**En az 5 dilim yaz:**

| Dilim | Baktığı veri | Standardize şema entity'leri |
|---|---|---|
| `liquidity` | Pool derinliği, LP dağılımı, likidite kilitleri | `LiquidityPool`, `LiquidityPoolDailySnapshot` |
| `holders` | Cüzdan dağılımı, konsantrasyon, yeni adres oranı | `Account`, `UsageMetricsDailySnapshot` |
| `bridge` | Zincirler arası akış, kaynak/hedef desenleri | bridge subgraph'leri |
| `activity` | İşlem zamanlaması, gas desenleri, tekrar eden yollar | `UsageMetricsDailySnapshot`, `Transaction` |
| `comparative` | Benzer protokollerle standardize şema üzerinden kıyas | `Protocol`, `FinancialsDailySnapshot` — **çok protokolde tek sorgu** |

**`comparative` dilimi özellikle önemli:** Messari Standardized Subgraph'ın asıl gücü tek sorgu deseninin onlarca protokolde çalışması. Bu dilim 5+ protokolü aynı sorguyla tarayacak. The Graph track'inin "standarttan gelen kaldıraç" şartının kanıtı bu.

**Kabul kriterleri (hepsi sağlanmalı):**
- 5 dilim de gerçek veri dönüyor
- Her dilim farklı entity/sorgu kullanıyor
- `comparative` en az 5 protokolü tek sorgu deseniyle tarıyor
- Maliyetler raporlanıyor

**Dikkat:** Dilimlerin çıktıları gerçekten farklı olmalı. İkisi aynı sonuca varıyorsa bir tanesini değiştir.

### TEST KAPISI — ADIM 19

**Bu kapı geçilmeden ADIM 20'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 19 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 20 — Agent Runner

**Amaç:** Bir agent'ın kanıt→rapor pipeline'ını kur.

**Yapılacaklar:**

`apps/agent/src/runner.ts`:

```typescript
export interface AgentConfig {
  id: string;
  hederaAccountId: string;
  ensName: string;
  sliceIds: string[];        // baktığı veri dilimleri
  persona: string;           // prompt kişiliği
  model: string;             // 'claude-sonnet-5'
  behavior: 'honest' | 'liar' | 'lazy';   // demo senaryoları için
}

export class Agent {
  /** Bir soruya bond yatırıp yatırmayacağına karar verir. */
  async decideToBond(market: MarketSummary): Promise<boolean>;

  /** Çekildiğinde çağrılır: kanıt topla, muhakeme et, inanç üret. */
  async produceReport(
    question: string,
    history: Report[],
    prior: Belief
  ): Promise<{ belief: Belief; reasoning: string; evidence: SliceEvidence[] }>;
}
```

**Rapor üretme akışı:**
```
1. Kendi veri dilimlerinden kanıt çek (x402 ile öder)
2. Önceki raporların tamamını oku (HCS'ten veya API'den)
3. LLM'e ver:
   - Soru
   - Kendi kanıtı (dilim özetleri)
   - Önceki raporların dizisi
   - "Sen bir tahmin agent'ısın, kendi kanıtını ve piyasa geçmişini
      birleştirip bir olasılık üret" talimatı
4. LLM'den yapılandırılmış çıktı al: { probability: number, reasoning: string }
5. Belief'e çevir: [1-p, p]
6. behavior === 'liar' ise ters çevir, 'lazy' ise son raporu kopyala
```

**Teknik gereksinimler:**
- Anthropic SDK, model `claude-sonnet-5`
- Yapılandırılmış çıktı için tool use veya JSON mode
- Olasılık `[0.01, 0.99]` dışına çıkarsa API tarafında kırpılacak (agent'ın kendisi kırpmasın, ham değeri göndersin)
- Her rapor için `reasoning` saklanacak, frontend'de gösterilecek
- Agent kendi HTTP endpoint'ini expose eder: `POST /report` (orchestrator buraya çağrı yapar)

**Kabul kriterleri (hepsi sağlanmalı):**
- Tek bir agent gerçek bir soru için kanıt çekip rapor üretiyor
- Kanıt maliyeti raporlanıyor
- `reasoning` anlamlı ve dilimlere atıfta bulunuyor
- Üç `behavior` modu da çalışıyor

**Dikkat:** `behavior` alanı demo senaryoları için var. Varsayılan `honest`. Bu alan konfigürasyon, koda gömülü değil.

### TEST KAPISI — ADIM 20

**Bu kapı geçilmeden ADIM 21'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 20 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 21 — 20 Agent Konfigürasyonu ve Havuz

**Amaç:** Havuzu tohumla.

**Yapılacaklar:**

`agents/config.json` — 20 agent tanımı:

```json
[
  {
    "id": "agent-01",
    "sliceIds": ["liquidity"],
    "persona": "Likidite yapısına odaklanan analist. Pool derinliği, LP konsantrasyonu ve kilit sürelerine bakarsın.",
    "model": "claude-sonnet-5",
    "behavior": "honest"
  }
]
```

**Dağılım kuralı:**
- 5 dilim × 4 agent = 20
- Aynı dilime bakan 4 agent farklı `persona` almalı (farklı ağırlık, farklı zaman penceresi, farklı eşik)
- Hiçbir iki agent birebir aynı konfigürasyona sahip olmamalı

`scripts/register-agents.ts`:
- `config.json`'u oku
- Her agent için `POST /agents/register` çağır
- Hedera hesabını bağla
- Sonucu logla

**Agent process yönetimi:**
- Tek bir Node process'i 20 agent'ı da barındırabilir (her biri ayrı port veya ayrı route)
- Ama her agent'ın kendi cüzdanı ve kendi kimliği olmalı
- `pnpm agents:start` ile hepsi ayağa kalkacak

**Kabul kriterleri (hepsi sağlanmalı):**
- 20 agent kayıtlı ve ayakta
- Her biri farklı konfigürasyona sahip
- Aynı soruya farklı cevaplar veriyorlar (test et — hepsi aynı çıkarsa dilimler yeterince ayrışmamış)

**Dikkat:** Kabul kriterinin son maddesi demonun canlılığını belirliyor. 20 agent da %72 derse demo ölü görünür. Gerçek bir soruyla test et ve dağılımı gör.

### TEST KAPISI — ADIM 21

**Bu kapı geçilmeden ADIM 22'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 21 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 22 — x402 ile Satılan Çözümleme Servisi

**Amaç:** Hedera track'inin "gerçek bir x402-gated servis kur ve onu tüketen platformu yap" şartını doldur.

**Yapılacaklar:**

`POST /resolve` endpoint'ini tamamla:

```
Girdi:  { question, contextHints? }
Ödeme:  sabit servis ücreti (x402, Hedera)
Çıktı:  {
  probability: 0.72,
  reportCount: 8,
  agentBreakdown: [{ agentId, ensName, belief, sliceIds }],
  marketId: "...",
  hcsTopicId: "...",
  evidenceCostUsd: 0.043
}
```

**Davranış:**
- İstek gelince yeni bir market açılır ve tam mekanizma koşar
- Ya da mevcut kapanmış bir market varsa onun sonucu döner (cache)
- Sonuç HCS referansıyla birlikte döner, çağıran doğrulayabilir

**Bu servisin anlamı:** Marketin kendisi bir ürün. İsteyen çağrı başına ödeyip bir soruya "piyasa fiyatı" alabiliyor. Platform (market UI) da bu servisi tüketiyor.

**Kabul kriterleri (hepsi sağlanmalı):**
- Ödemesiz istek 402
- Ödemeli istek market koşturup sonuç dönüyor
- Dönen sonuç HCS'ten bağımsız olarak doğrulanabiliyor
- Bir agent (veya curl) bu servisi tüketebiliyor — bu demo videosunda gösterilecek

### TEST KAPISI — ADIM 22

**Bu kapı geçilmeden ADIM 23'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 22 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

# FAZ 4 — ENS ENTEGRASYONU (Gün 9-10)

---

## ADIM 23 — ENS Rol Şeması Tasarımı (KOD YOK)

**Amaç:** Rol dağılımını kod yazmadan önce kağıt üzerinde bitir.

**Neden bu ayrı bir adım:** ENSv2'de isim bazında **admin rolleri sadece registration anında** verilebiliyor. Registration'dan sonra düzeltilemez. Yanlış şema ile 20 subname mint edersen hepsini baştan yapman gerekir.

**Yapılacaklar:**

`docs/ens-role-schema.md` yaz. Şu soruların hepsine cevap ver:

1. Parent isim ne? (`<proje>.eth` benzeri)
2. Her agent subname'i kime ait olacak? (agent'ın kendi cüzdanı)
3. Agent hangi record'ları düzenleyebilecek?
   - `description`, `url`, `avatar` → **agent düzenleyebilir**
   - `model`, `slices` → agent düzenleyebilir
4. Agent hangi record'ları düzenleyemeyecek?
   - `score.calibration`, `score.markets`, `score.slashed` → **sadece orchestrator**
5. Bu ayrım hangi rol/kaynak yapısıyla sağlanacak?
   - Seçenek A: agent'a kendi resolver'ı, orchestrator'a o resolver üzerinde sınırlı rol
   - Seçenek B: iki ayrı resolver (profil + skor)
   - Hangisini seçtin ve neden?
6. Slash edilen agent'ın subname'i nasıl revoke edilecek? Hangi rol gerekiyor?
7. Expiry var mı? Varsa süresi ne, kim yenileyebilir?
8. `roleBitmap` her mint için tam olarak hangi değeri alacak?

**Kabul kriterleri (hepsi sağlanmalı):** Yukarıdaki 8 sorunun hepsinin yazılı cevabı var ve `roleBitmap` değeri hesaplanmış durumda.

**Dikkat:** Bu adımı atlayıp koda geçme. ADIM 4'te (spike) admin rolü kısıtını deneysel olarak doğrulamıştın, o sonucu buraya taşı.

### TEST KAPISI — ADIM 23

**Bu kapı geçilmeden ADIM 24'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 23 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 24 — ENS Registry Deploy ve Parent Kurulumu

**Amaç:** Kendi subname registry'ni kalıcı olarak kur.

**Yapılacaklar:**

`packages/ens/src/registry.ts`:

```typescript
export async function deployUserRegistry(): Promise<Address>;
export async function setParent(registry: Address, parentName: string): Promise<void>;
export async function grantRootRoles(registry: Address, roles: bigint, to: Address): Promise<void>;
export async function registerSubname(params: {
  registry: Address;
  label: string;
  owner: Address;
  resolver: Address;
  roleBitmap: bigint;
  expiry: bigint;
}): Promise<{ tokenId: bigint; txHash: Hash }>;
```

**Teknik gereksinimler:**
- viem, Sepolia
- Verifiable Factory üzerinden UserRegistry proxy deploy
- ADIM 23'teki şemaya birebir uy
- Deploy edilen adresler `deployments/sepolia.json` dosyasına yazılsın

**Kabul kriterleri (hepsi sağlanmalı):**
- Registry deploy edildi ve adresi kaydedildi
- Parent bağlantısı kuruldu
- Root roller verildi
- Bir test subname'i mint edilip doğrulandı

### TEST KAPISI — ADIM 24

**Bu kapı geçilmeden ADIM 25'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 24 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 25 — 20 Agent Subname Mint'i

**Amaç:** Her agent'a kalıcı kimlik ver.

**Yapılacaklar:**

`scripts/mint-ens-subnames.ts`:
- `agents/config.json` ve `agents/accounts.json`'u oku
- Her agent için:
  - Sepolia adresi türet (agent'ın kendi anahtarından)
  - `agent-01.<parent>.eth` mint et
  - Permissioned Resolver ata
  - Başlangıç text record'larını yaz:
    ```
    description  → persona özeti
    model        → claude-sonnet-5
    slices       → "liquidity,comparative"
    hedera.account → 0.0.xxxx
    score.markets → 0
    score.calibration → (boş)
    ```
- Sonucu `agents/ens.json`'a yaz

**Kabul kriterleri (hepsi sağlanmalı):**
- 20 subname mint edildi
- Hepsi Sepolia explorer'da görünüyor
- Text record'lar okunabiliyor
- Agent kendi profil record'unu güncelleyebiliyor
- Agent skor record'unu güncelleyemiyor (**bunu test et, revert etmeli**)

**Dikkat:** Son iki kabul kriteri ENS track'inin can damarı. "Enhanced Access Control'ü gerçekten kullandık" iddiasının kanıtı bu testtir. Test kodunu sakla, videoda göster.

### TEST KAPISI — ADIM 25

**Bu kapı geçilmeden ADIM 26'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 25 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 26 — Reputation Yazıcı

**Amaç:** Market sonuçlarını agent kimliğine bağla.

**Yapılacaklar:**

`packages/ens/src/reputation.ts`:

```typescript
export interface AgentReputation {
  marketsParticipated: number;
  marketsScored: number;
  cumulativeScore: number;
  averageScore: number;
  timesSlashed: number;
  timesReference: number;
}

/** Settlement sonrası çağrılır, ENS text record'larını günceller. */
export async function updateReputation(
  agentEnsName: string,
  settlement: Settlement
): Promise<void>;

export async function readReputation(agentEnsName: string): Promise<AgentReputation>;
```

**Orchestrator'a bağla:** `settle()` tamamlandıktan sonra her katılımcı agent'ın reputation'ı güncellensin.

**Kabul kriterleri (hepsi sağlanmalı):**
- Bir market koştuktan sonra agent'ların ENS record'ları güncelleniyor
- `readReputation` doğru değerleri dönüyor
- Sadece orchestrator yazabiliyor (agent'ın yazma denemesi revert ediyor)

**Dikkat:** Sepolia yazma işlemi yavaş ve gas maliyetli. Her market sonunda 8 agent × 3 record = 24 yazma olacak. Batch'le veya sadece özet skoru yaz.

### TEST KAPISI — ADIM 26

**Bu kapı geçilmeden ADIM 27'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 26 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

# FAZ 5 — FRONTEND (Gün 11-12)

---

## ADIM 27 — Market Listesi ve Soru Sorma

**Amaç:** Jürinin kendi sorusunu sorabileceği giriş noktası.

**Yapılacaklar:**

Next.js App Router, Tailwind.

**`/` — Market listesi:**
- Açık, koşan ve kapanmış marketler
- Her kart: soru, mevcut fiyat, rapor sayısı, durum, kalan süre
- Durum rozetleri: bonding / running / closed / settled / cancelled

**`/new` — Soru sorma:**
- Soru metni girişi
- Parametre önizlemesi (k, T, α — varsayılanlar, ileri düzey açılır menüde değiştirilebilir)
- **Gerekli deposit hesabı canlı gösterilsin:** `b·log2 + k·R`
- Cüzdan bağlantısı ve x402 ödemesi
- Ödeme sonrası markete yönlendir

**Kabul kriterleri (hepsi sağlanmalı):**
- Liste gerçek API'den besleniyor
- Soru sorup ödeme yapılabiliyor
- Deposit hesabı doğru ve canlı güncelleniyor

**Dikkat:** Bu sayfa demo senaryosu 4'ün (jüri kendi sorusunu sorar) sahnesi. Akışın pürüzsüz olması gerekiyor.

### TEST KAPISI — ADIM 27

**Bu kapı geçilmeden ADIM 28'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 27 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 28 — Canlı Market Sayfası

**Amaç:** Mekanizmayı görünür kıl. Demo videosunun ana ekranı.

**Yapılacaklar:**

**`/market/[id]`:**

1. **Fiyat grafiği** (Recharts veya benzeri)
   - X ekseni: agent pozisyonu (1..n)
   - Y ekseni: P(Y=1)
   - Prior'dan başlayan çizgi, her raporla kırılıyor
   - Son nokta (referans agent) vurgulanmış
   - Canlı güncelleme (polling veya SSE)

2. **Rapor akışı**
   - Her rapor kartı: agent ENS ismi, avatar, pozisyon, önceki→yeni fiyat, hareket yönü
   - `reasoning` metni açılır kapanır
   - Baktığı veri dilimleri rozet olarak
   - Kanıt maliyeti (`$0.008 harcadı`)

3. **Market durumu paneli**
   - Parametreler: k, T, α, ε
   - Beklenen uzunluk, mevcut uzunluk
   - Bonding havuzu: N kaç, minimum kaç
   - Kapanma olasılığı göstergesi
   - HCS topic linki (HashScan)

4. **Kapanış paneli** (market kapandıysa)
   - Referans agent kim, raporu ne
   - Kapanma sebebi: durma kuralı / havuz tükendi
   - Durma kararının doğrulanabilir hash'i

**Kabul kriterleri (hepsi sağlanmalı):**
- Grafik canlı güncelleniyor
- Raporlar geldikçe akışa ekleniyor
- HCS linkleri çalışıyor
- Kapanışta referans agent net şekilde işaretli

**Dikkat:** Bu ekran videoda en çok görünecek yer. Fiyatın hareket ettiğinin ve agent'ların farklı düşündüğünün görsel olarak anlaşılması şart.

### TEST KAPISI — ADIM 28

**Bu kapı geçilmeden ADIM 29'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 28 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 29 — Agent Kartları ve Dizin

**Amaç:** ENS kimliğini görünür kıl.

**Yapılacaklar:**

**`/agents` — Agent dizini:**
- 20 agent kartı
- Her kart ENS'ten okunuyor: isim, avatar, description, model, slices
- Reputation: katıldığı market sayısı, ortalama skor, kaç kez referans oldu, kaç kez slash edildi
- ENS isminden Sepolia explorer'a link

**`/agents/[name]` — Agent detayı:**
- Tüm ENS text record'ları
- Katıldığı marketlerin listesi ve her birindeki performansı
- Skor geçmişi grafiği

**Kabul kriterleri (hepsi sağlanmalı):**
- Veriler gerçekten ENS'ten okunuyor (API cache'inden değil)
- Reputation güncel
- Explorer linkleri çalışıyor

**Dikkat:** ENS track'inin görsel kanıtı bu sayfa. "Kimlik gerçekten zincirde" mesajını vermeli.

### TEST KAPISI — ADIM 29

**Bu kapı geçilmeden ADIM 30'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 29 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 30 — Settlement Görünümü

**Amaç:** Paranın nereye gittiğini şeffaf göster.

**Yapılacaklar:**

Market sayfasına settlement sekmesi:

- **Ödeme tablosu:** her agent, pozisyon, tip (scored/flat-fee), ham skor, ödeme miktarı
- **Renk kodu:** pozitif yeşil, negatif kırmızı, flat-fee gri
- **Muhasebe özeti:**
  ```
  Asker deposit'i          X
  Agent bond'ları toplamı  Y
  ─────────────────────────
  Agent'lara ödenen        A
  Sabit ücretler           B
  Slash edilen             C
  Asker'a iade             D
  ─────────────────────────
  Kontrol: X + Y = A + B + D + (iade edilen bond'lar)  ✓
  ```
- **Bütçe sınırı göstergesi:** "Teorik maksimum maliyet: `b·log2 + k·R` = Z. Gerçekleşen: W. Kanıt: paper §6.2 teleskoplama."
- Hedera transfer linkleri (HashScan)

**Kabul kriterleri (hepsi sağlanmalı):**
- Muhasebe ekranda kapanıyor
- Bütçe sınırı gösteriliyor ve gerçekleşen değer sınırın altında
- Transfer linkleri çalışıyor

**Dikkat:** Bütçe sınırı göstergesi jüriye "bu adam mekanizmanın matematiğini anlamış" mesajını veren detay. Küçük ama değerli.

### TEST KAPISI — ADIM 30

**Bu kapı geçilmeden ADIM 31'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 30 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

# FAZ 6 — TESLİMAT (Gün 13-14)

---

## ADIM 31 — Demo Senaryolarının Otomasyonu

**Amaç:** Üç senaryoyu tek komutla koşulabilir hale getir.

**Yapılacaklar:**

`scripts/run-scenario.ts`:

```bash
pnpm scenario normal      # 20 dürüst agent
pnpm scenario liar        # 19 dürüst + 1 yalancı
pnpm scenario lazy        # 20 tembel agent
pnpm scenario mixed       # 10 dürüst + 5 yalancı + 5 tembel
```

Her senaryo:
- Agent `behavior` alanlarını geçici olarak ayarlar
- Sabit bir soru ile market açar
- Marketi sonuna kadar koşturur
- Settlement'ı basar
- Sonucu `docs/scenarios/<name>.json` olarak kaydeder

**Beklenen sonuçlar (doğrula):**

| Senaryo | Beklenen |
|---|---|
| normal | Fiyat yakınsıyor, ödemeler bütçe içinde |
| liar | Yalancı agent'ın ödemesi negatif |
| **lazy** | **İlk agent hariç herkesin ödemesi TAM SIFIR** |
| mixed | Dürüstlerin ortalama ödemesi en yüksek |

**Kabul kriterleri (hepsi sağlanmalı):** Dört senaryo da koşuyor ve beklenen sonuçları üretiyor.

**Dikkat:** `lazy` senaryosu paper Teorem 7'nin canlı kanıtı. Videoda gösterilecek en güçlü an. Ekranda tam sıfır görünmeli.

### TEST KAPISI — ADIM 31

**Bu kapı geçilmeden ADIM 32'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 31 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 32 — README'ler ve Mimari Diyagram

**Amaç:** Her sponsor kendi kesitini net görsün.

**Yapılacaklar:**

**`README.md` (ana):**
- Ne inşa ettik, tek paragraf
- Paper referansı ve mekanizmanın 5 cümlelik özeti
- Mimari diyagram
- Kurulum ve çalıştırma
- Senaryolar nasıl koşulur
- **Dürüstlük beyanları bölümü** (aşağıdaki dört metin birebir girecek)

**Dürüstlük beyanları — README'ye aynen yaz:**

> **Agent operasyonu.** Protokol izinsiz katılıma açıktır, agent kaydı herkese açıktır. Bu demoda ağı biz tohumladık ve 20 agent'ı biz işletiyoruz. Soru sorma tarafı tamamen açıktır. Yol haritası: dış agent kaydının açılması, havuz büyüdükçe k'nın teorik değerine yükseltilmesi.

> **k parametresi.** Teorem 1, varsaydığımız sinyal kalitesi için (δ=0.5, η=0.1, ε=0.05) k≈6 gerektiriyor. Demo, 20 agent'lık havuzla çalışabilirlik için k=3 ile koşuyor. k protokol parametresidir. Repoda Teorem 1'i hesaplayan hesaplayıcı bulunmaktadır (`scripts/kcalc.ts`).

> **Havuz tükenmesi.** Mekanizma durma zamanının tahmin edilemez olmasını gerektiriyor. Sonlu havuzda bu, son pozisyon hariç her yerde sağlanıyor. N=20, α=1/8 ile havuzun tükenme ihtimali %7.9; bu durumda market zorla kapanır ve `closedReason = 'pool-exhausted'` olarak işaretlenir.

> **Varsayım 4.** Paper agent sinyallerinin koşullu bağımsızlığını varsayıyor ve sonuç bölümünde bunu gevşetmeyi gelecek çalışma olarak işaret ediyor. Biz her agent'a farklı bir veri dilimi atayarak bu varsayıma yaklaşmaya çalışıyoruz, ama tam olarak sağlandığını iddia etmiyoruz.

> **Custody.** Settlement matematiği logaritma içerdiği için para yolunda akıllı kontrat kullanmıyoruz. Fonlar v1'de operatör treasury hesabında tutuluyor. Tüm defter (raporlar, durma kararları, ödemeler) HCS'e yazılıyor, dolayısıyla her hesaplama bağımsız olarak yeniden üretilebilir ve doğrulanabilir.

**`docs/README-hedera.md`:**
- x402-gated servis nerede (`POST /resolve`), nasıl tüketilir
- Blocky402 entegrasyonu, hangi paketler
- HCS'in mekanizmadaki rolü (süs değil, denge ispatının gereksinimi)
- HCS running hash'ten rastgelelik türetimi ve doğrulama fonksiyonu
- Uçtan uca ödeme akışı diyagramı
- HashScan linkleri (örnek market)

**`docs/README-graph.md`:**
- Veri dilimleri ve Varsayım 4 bağlantısı
- Messari Standardized Subgraph kullanımı, `comparative` diliminin çok protokollü tek sorgusu
- x402 per-query ödeme, API key olmaması
- Agent'ın girdisi için ödeyip çıktısı için ödeme alması
- Örnek sorgular ve maliyetler

**`docs/README-ens.md`:**
- Rol şeması (`docs/ens-role-schema.md`'ye link)
- Enhanced Access Control'ün nerede kullanıldığı
- Agent kendi profilini düzenler ama skorunu düzenleyemez — **test dosyasına link**
- Subname revoke akışı
- Deploy adresleri

**`docs/architecture.md`:**
Mimari diyagram (mermaid):
- Asker → API (x402/Hedera)
- Agent → Graph Gateway (x402/USDC)
- Agent → API (rapor)
- API → HCS (defter + rastgelelik)
- API → ENS Sepolia (reputation)
- API → Hedera (settlement transferleri)

**Kabul kriterleri (hepsi sağlanmalı):** Dört README de yazıldı, diyagram render oluyor, dürüstlük beyanları birebir yerinde.

### TEST KAPISI — ADIM 32

**Bu kapı geçilmeden ADIM 33'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 32 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 33 — Demo Videoları

**Amaç:** Üç sponsor için üç video.

**Yapılacaklar:**

**Video 1 — The Graph (2-4 dakika):**
1. Soru sorulur (zincir üstü forensics sorusu)
2. Bir agent'ın veri dilimini çekişi gösterilir, x402 ödemesi görünür
3. `comparative` diliminin tek sorguyla 5 protokolü taradığı gösterilir
4. Farklı dilimlere bakan agent'ların farklı sonuçlara vardığı gösterilir
5. **Anlatım:** "Veri dilimi ayrıştırması kozmetik değil, mekanizmanın Varsayım 4'ü bunu gerektiriyor"

**Video 2 — Hedera (≤5 dakika):**
1. `POST /resolve` servisine curl ile ödemesiz istek → 402
2. x402 ile ödeme → market koşuyor → sonuç dönüyor
3. HashScan'de ödeme ve HCS mesajları gösterilir
4. Durma kararının running hash'ten doğrulanması canlı gösterilir
5. Settlement transferleri HashScan'de
6. **Anlatım:** "HCS burada süs değil, SKC'nin denge ispatı sıralı ve değiştirilemez geçmiş gerektiriyor"

**Video 3 — ENS (live demo linki + kısa video):**
1. Agent dizini, ENS'ten okunan kimlikler
2. Bir agent'ın kendi profil record'unu güncellemesi (başarılı)
3. Aynı agent'ın skor record'unu güncellemeye çalışması (**revert**)
4. Market sonrası reputation'ın otomatik güncellenmesi
5. **Anlatım:** "Enhanced Access Control ile agent kendini tanımlar ama kendini puanlayamaz"

**Ortak — üç videoda da gösterilecek 30 saniye:**
`pnpm scenario lazy` koşulur, ekranda **herkesin ödemesi tam sıfır** görünür.
**Anlatım:** "Bütün agent'lar tembellik edip birbirini kopyalarsa hiç kimse hiçbir şey kazanmıyor. Bu paper'ın Teorem 7'si ve mekanizmanın 'hiçbir şey yapmadan para al' açığını nasıl kapattığının kanıtı."

**Kabul kriterleri (hepsi sağlanmalı):** Üç video da çekildi, süre sınırları içinde, her biri kendi sponsorunun şartlarını açıkça karşılıyor.

### TEST KAPISI — ADIM 33

**Bu kapı geçilmeden ADIM 34'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 33 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

## ADIM 34 — Submission Kontrol Listesi

**Amaç:** Hiçbir şart atlanmasın.

**Yapılacaklar:**

Her track için şartları tek tek doğrula:

**Hedera — AI & Agentic Payments:**
- [ ] Hedera testnet/mainnet üzerinde canlı x402-gated servis, Blocky402 facilitator ile
- [ ] Servisi tüketen platform, en az bir gerçek ödemeli istek uçtan uca
- [ ] Public GitHub repo, README'de kurulum + mimari + ödeme akışı
- [ ] ≤5 dakika demo videosu, ödemeli isteğin çalıştığı görülüyor
- [ ] Ekstra puan: HCS ile doğrulanabilir ödeme denetim izi ✓

**The Graph — AI Use Case (From Scratch):**
- [ ] The Graph load-bearing: agent'ların canlı veri kaynağı
- [ ] Canlı veri, mock/local/statik yok
- [ ] Veriyle anlamlı iş: muhakeme, karar, otomasyon
- [ ] Açık kaynak, net README
- [ ] Public repo + 2-4 dakika demo videosu
- [ ] Doğru havuz seçildi: **Start Fresh**

**ENS — Best Use of ENSv2:**
- [ ] ENSv2 Sepolia üzerinde
- [ ] ENSv2 özellikleri merkezi, kozmetik değil
- [ ] Demo fonksiyonel, hardcode değer yok
- [ ] Video kaydı VE canlı demo linki
- [ ] Açık kaynak

**Genel:**
- [ ] Repo public
- [ ] `.env` ve anahtar dosyaları git'te değil
- [ ] Commit geçmişi düzgün (son gün tek commit değil)
- [ ] Üç track de doğru havuza submit edildi

**Kabul kriterleri (hepsi sağlanmalı):** Tüm kutular işaretli.

### TEST KAPISI — ADIM 34

**Bu kapı geçilmeden ADIM 35'e GEÇME.**

```
1. Yukarıdaki kabul kriterlerinin TAMAMI sağlandı mı?
2. Bu adım için yazılan testler yeşil mi?
3. pnpm test        → TÜM suite yeşil (önceki adımların testleri dahil)
4. pnpm -r build    → hatasız
5. docs/step-log.md'ye kayıt düşüldü mü?
```

**Otomatik test yazılamayan adımlarda** (spike, deploy, frontend, video): kabul
kriterlerini manuel doğrula ve kanıtı step-log'a ekle — terminal çıktısı, explorer
linki veya ekran görüntüsü.

**`docs/step-log.md` kaydı şu formatta:**

```markdown
## ADIM 34 — <başlık>
- Tarih:
- Durum: GEÇTİ / KALDI
- Yazılan test sayısı:      Geçen:      Kalan:
- Tam suite: X/Y yeşil
- Kullanılan paket sürümleri:
- Karşılaşılan tuzaklar:
- Kanıt (link/çıktı):
```

**Kırmızı test varsa:** düzelt, tekrar çalıştır. Kırmızı testle ilerleme — sonraki
adımlar bu adımın üstüne inşa ediliyor ve hata katlanarak büyür.

**Bana raporla:** ne yapıldı, hangi testler yazıldı, tam suite durumu, kalan risk.

---

# EK — İLERLEME TAKİBİ

| Faz | Adımlar | Gün | Durum |
|---|---|---|---|
| 0 — Kurulum ve spike'lar | 1-5 | 1 | ☐ |
| 1 — Çekirdek mekanizma | 6-11 | 2-3 | ☐ |
| 2 — Hedera | 12-17 | 4-6 | ☐ |
| 3 — The Graph | 18-22 | 7-8 | ☐ |
| 4 — ENS | 23-26 | 9-10 | ☐ |
| 5 — Frontend | 27-30 | 11-12 | ☐ |
| 6 — Teslimat | 31-34 | 13-14 | ☐ |

**Kesilebilir parçalar (zaman daralırsa, bu sırayla):**
1. ADIM 29 (agent detay sayfası) → dizin yeter
2. ADIM 26 (reputation yazıcı) → statik record'lar yeter
3. ADIM 23-26 tamamı (ENS) → track kaybı ama diğer ikisi ayakta kalır

**Asla kesilmeyecekler:**
- ADIM 7-9 (skorlama, state machine, settlement) — mekanizmanın kendisi
- ADIM 11 (senaryo testleri) — özellikle `lazy` senaryosu
- ADIM 13-14 (HCS + rastgelelik) — Hedera anlatımının temeli
- ADIM 19 (veri dilimleri) — Graph anlatımının temeli
- ADIM 32 (dürüstlük beyanları) — güvenilirliğin temeli
