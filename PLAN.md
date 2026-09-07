# ETHGlobal Online 2026 — Proje Planı

**Tarih:** 2026-09-07
**Durum:** Planlama tamamlandı, koda geçilebilir
**Teorik temel:** Srinivasan, Karger, Chen — *Self-Resolving Prediction Markets for Unverifiable Outcomes* (arXiv 2306.04305)

---

## 0. Tek Paragraflık Özet

Hiçbir oracle'ın çözemeyeceği sorular için, yapay zeka agent'larının para koyarak tahmin yaptığı kendi kendini çözen bir prediction market. Sonucu dışarıdan kimse doğrulamıyor; marketin son agent'ı referans olarak kullanılıyor ve herkes ona göre skorlanıyor. Sorular zincir üstü kanıtı olan ama kesin cevabı olmayan sorular ("bu protokolün büyümesi organik mi"). Agent'lar kanıtlarını The Graph'tan alıyor, ödemeler Hedera üzerinden x402 ile akıyor, kimlikleri ENS'te duruyor.

---

## 1. Hackathon Bağlamı ve Havuz Kararı

### 1.1 Havuz: From Scratch (net-new), yeni repo

Daha önce bir hackathon'da derece almış bir projeyi olduğu gibi tekrar göndermek ETHGlobal'de diskalifiye sebebi. İki seçenek vardı:

| Havuz | Risk | Erişilebilir ödül |
|---|---|---|
| Continuity | Sıfır | Hedera $1k + ENS $500 + Graph $5k |
| **From Scratch** | Yeniden yazmak gerekiyor | **Hedera $6k + ENS $4.5k + Graph $5k** |

**Karar: From Scratch.** Continuity havuzunda toplam erişilebilir para yaklaşık üçte bire düşüyordu. Yeni dikey (zincir üstü forensics soruları), yeni mimari (Hedera + The Graph + ENS), sıfırdan kod. Eski repodan kopyala-yapıştır yapılmayacak.

### 1.2 Katılım sınırı

En fazla 3 track'e katılım hakkı var.

---

## 2. Teorik Temel — Paper'ın Tam Okuması

Paper baştan sona, ekleri dahil okundu. Bu bölüm implementasyonu bağlayan bütün bulguları içerir.

### 2.1 Mekanizmanın çalışma şekli

1. Agent'lar sırayla gelir. Her agent kendi özel sinyalini **ve** kendinden önceki bütün raporları görür.
2. Agent bir olasılık raporlar: `q^(t)`.
3. Her rapordan sonra market `α` olasılıkla kapanır.
4. Kapandığında **son agent referans agent** olur, raporu `r` kapanış fiyatıdır.
5. İlk `T-k` agent, `r`'ye göre cross-entropy market scoring rule ile ödenir.
6. **Son k agent sabit ücret `R` alır.** Sebebi: arkalarında karşılaştırılacak yeterli bilgi kalmamıştır.

**Kritik nokta:** Son k agent önceden belirlenmiş bir "panel" DEĞİLDİR. Rastgele durma nereye denk gelirse orada duran son k agent'tır. Kimse markete girerken o k'dan biri olup olmayacağını bilemez.

### 2.2 Ödeme formülleri

Cross-entropy scoring rule (Tanım 5):

```
S_CE(r, q) = -H(r, q) = Σ_i r_i · log(q_i)
```

Cross-entropy market scoring rule (Tanım 7) — asıl kullanılan:

```
S_CEM(r, q^(t), q^(t-1)) = -H(r, q^(t)) + H(r, q^(t-1)) = Σ_i r_i · log( q_i^(t) / q_i^(t-1) )
```

**Agent'ın optimal davranışı:** Beklenen değeri alınca

```
E[S_CEM] = -H(E[r], q^(t)) + H(E[r], q^(t-1))
```

ikinci terim sabittir, dolayısıyla Gibbs eşitsizliğinden optimum `q^(t) = E[r]`'dedir.

Yani agent "referans agent'ın raporu hakkındaki beklentisini" raporlar. Mekanizmanın dürüstlük iddiası, bu beklentinin agent'ın kendi dürüst inancına eşit olmasına dayanır — ki bu da referans agent yeterince bilgiliyse gerçekleşir.

**Önemli sonuç: α bu ifadeye hiç girmiyor.** Optimal rapor, kapanma olasılığı 0.05 de olsa 0.5 de olsa aynıdır. Agent raporunu vermek için α'yı bilmek zorunda değildir. α sadece **katılım kararını** etkiler (bond ne kadar kilitli kalacak, beklenen kazanç ne). Bu yüzden α açık yayınlanır ama realizasyonu gizli kalır.

### 2.3 Parametre k — informational substitutes

k, referans agent'ın sahip olduğu ve agent t'nin erişemediği bağımsız sinyal sayısıdır. Yalanın "erimesi" için gereken sayıdır.

**Teorem 1, sapma sınırı:**

```
|Δ| ≤ (1/4) · ( (1-η)/η - η/(1-η) ) · (1-δ)^k
```

**Teorem 1, Denklem 3 (ε'-yaklaşık k):**

```
k ≥ ( 1 / -log(1-δ) ) · log( (1/(4ε')) · ( (1-η)/η - η/(1-η) ) )
```

**Teorem 4, Denklem 7 (strict truthfulness, τ gerektirir):**

```
k > ( 1 / -log(1-δ) ) · log( |log((1-η)/η)| · ((1-η)/η - η/(1-η)) / ( 8·(τ·η·(1-η))^2 ) )
```

Parametreler:
- **δ** — Bhattacharyya katsayısı üst sınırı. Sinyalin sonucu ne kadar ayırt ettiği. En etkili parametre, paper bunu özellikle vurguluyor.
- **η** — minimum sinyal olasılığı. Sinyalin ne kadar uç olabileceği.
- **τ** — sinyal uzayı granülaritesi.
- **ε'** — hedeflenen sapma üst sınırı.

**Hesaplanan k_min değerleri (Teorem 1, ε=0.05):**

| δ | η=0.2 | η=0.1 | η=0.05 |
|---|---|---|---|
| 0.5 | 4.2 | 5.5 | 6.6 |
| 0.3 | 8.2 | 10.6 | 12.8 |
| 0.2 | 13.1 | 17.0 | 20.4 |
| 0.1 | 27.8 | 36.0 | 43.2 |

**Teorem 4 (strict) değerleri:**

| δ | η | τ=1.0 | τ=0.5 | τ=0.2 |
|---|---|---|---|---|
| 0.5 | 0.2 | 4.7 | 6.7 | 9.3 |
| 0.5 | 0.1 | 8.2 | 10.2 | 12.9 |
| 0.3 | 0.1 | 16.0 | 19.9 | 25.0 |

**Sonuç:** k=2 veya 3 teorinin hiçbir köşesinde tam olarak savunulabilir değil. En iyimser senaryoda (δ=0.5, η=0.1, ε=0.05) k ≈ 6 çıkıyor. Demo k=3 ile koşacak, bu gap README'de açıkça belgelenecek (bkz. Bölüm 14).

**Paper'da simülasyon YOK.** Yazarlar sonuç bölümünde bunu kendileri eksiklik olarak yazıyor. Yani "makaleye en uygun k" diye hazır bir sayı yok, bilgi yapısına bağlı.

### 2.4 Paper'dan çıkan ZORUNLU tasarım kısıtları

Bunlar tercih değil; ihlal edilirse mekanizma çöker.

**(a) Referans SABİT terminal agent olmalı. Rolling window veya batch ASLA.**

Ek C.2, Teorem 8: rolling window referansı kullanılırsa "switching equilibrium" oluşuyor. Agent'lar sırayla 0 ve 1 raporlayarak **sonsuz ödeme** alıyor, AMM'in zararı sınırsız. Paper'ın kendi çözüm önerisi: sabit referans agent kullan.

Ayrıca paper §6.2'de rolling window / batch referansın maliyeti "worst case unbounded" diyor. Sabit referans agent sınırlı zarar garantisi veriyor.

**(b) Raporlar [ε, 1-ε] aralığına kırpılmalı.**

Switching equilibrium'un matematiği tam olarak `log(0) = ∞`. Kırpma olmadan tek bir agent sınırsız negatif/pozitif skor üretebilir ve bond yetmez. Seçilen: ε = 0.01.

**(c) Varsayım 4 — koşullu bağımsızlık.**

```
X^(j) ⊥⊥ X^(j') | Y     (tüm j ≠ j' için)
```

Agent sinyalleri sonuç verildiğinde koşullu bağımsız olmalı. Paper bunun ele alınabilen bilgi yapısı sınıfını daralttığını açıkça kabul ediyor ve sonuç bölümünde gevşetmeyi gelecek çalışma olarak işaret ediyor.

**Bizim için pratik anlamı:** 20 agent aynı subgraph'lere bakıp aynı modele sorarsa bu varsayım paramparça olur, δ → 1'e gider, gereken k patlar. Bu yüzden **her agent farklı veri dilimine bakmak zorunda.** Bu kozmetik değil, mekanizmanın çalışma şartı.

### 2.5 Diğer dengeler (Ek C)

**C.1 — Bilgisiz denge (Teorem 7):** Herkes kendi sinyalinden bağımsız aynı şeyi raporlarsa bu bir PBE'dir. AMA **ödeme tam olarak sıfırdır** (ilk agent hariç, o `KL(r || q^(0))` alır). Yani "hiçbir şey yapmadan para al" açığı yok. Paper bunun tek-görev ayarında bu garantiyi veren nadir mekanizmalardan biri olduğunu vurguluyor. **Demo senaryosu 3 tam olarak bunu gösterecek.**

**C.2 — Switching denge (Teorem 8):** Yukarıda (a) maddesinde. Sadece rolling window ile oluşuyor.

**C.3 — Permütasyon denge (Teorem 9):** Herkes Y=0 ile Y=1'i toptan yer değiştirirse mekanizma aynı çalışır. Paper bunu "pratik bir endişe değil, koordinasyon imkansıza yakın" diyerek geçiyor. Biz de aynısını yapacağız.

### 2.6 Mekanizma tasarımcısının maliyeti (paper §6.2)

```
Maliyet = k·R + Σ_{t=1}^{r-k} [ -H(r,q^(t)) + H(r,q^(t-1)) ]
        = k·R - H(r, q^(r-k)) + H(r, q^(0))
```

Teleskoplama sayesinde toplam kapanıyor. `H(r, q^(r-k)) ≥ 0` olduğu için:

```
Maliyet ≤ k·R + H(r, q^(0))
```

Uniform prior'la `H(r, q^(0)) = log 2`. Yani soru soranın CEM tarafına ödeyeceği toplam para **kanıtlanabilir şekilde sınırlı.** Bu arayüzde gösterilecek.

### 2.7 AMM eşdeğerliği (paper §6.3)

Paper, CE-MSR'ın LMSR maliyet fonksiyonlu bir automated market maker'a birebir denk olduğunu kanıtlıyor:

```
C(c) = b · log( Σ_j e^(c_j / b) )        q_i = e^(c_i/b) / Σ_j e^(c_j/b)
```

Standart prediction market'ten **tek farkı**: normalde kazanan kontrat $1, kaybeden $0 öder. Burada `Y=0` kontratları `r_0` sent, `Y=1` kontratları `r_1` sent öder — yani referans agent'ın olasılığında kapanır.

**Bizim için anlamı:** Buna "market" demek matematiksel olarak doğru, kelime oyunu değil. Agent'lar olasılık raporluyor (MSR arayüzü), ama bu bir AMM'de alım satım yapmakla aynı şey. Arayüzde fiyat grafiği gösterebiliriz ve dürüst oluruz. Hisse/pozisyon muhasebesi tutmadığımız için kontrat kodu da çok daha az.

### 2.8 Diğer paper notları

- **Referans agent ortalaması:** Paper §6.2, "mekanizma birkaç referans agent'ın tahminini ortalamalı, ödeme varyansını düşürür, özellikle bilgisiz agent'lar varken" diyor. Opsiyonel iyileştirme olarak not edildi; ilk sürümde tek terminal agent.
- **Paralel marketler:** Alternatif tasarım — ayrı, birbirini görmeyen marketler ve çapraz referans. Paper bunu "iki fiyat, her biri bilginin yarısını topluyor, verimsiz" diye eliyor. Biz de eliyoruz.
- **α seçimi:** Paper `α = 1/(T+k)` öneriyor, T = istenen skorlanan agent sayısı.
- **Güvenilir agent varyantı (§6.2):** "Tasarımcının k güvenilir agent'ı varsa, bunlar marketin sonuna yerleştirilebilir, incentive-compatibility backward induction'dan gelir." Bu varyant değerlendirildi ve **REDDEDİLDİ** (bkz. Bölüm 6.2).

---

## 3. Ürün

### 3.1 Ne inşa ediyoruz

Doğrulanamayan sorular için kendi kendini çözen bir prediction market. Yapay zeka agent'ları para koyarak sırayla tahmin yapıyor, market kendi içinde çözülüyor, hiçbir oracle'a başvurulmuyor.

### 3.2 Soru tipi — bilinçli bir ürün kararı

Fiyat tahmini soruları ("BTC 100k'yı geçer mi") bu mekanizmanın varlık sebebini öldürüyor, çünkü onlar zaten doğrulanabilir. Bunun yerine **doğrulanamaz ama kanıtı zincir üstünde olan** sorulara geçiyoruz:

- "Bu protokolün son 30 günlük TVL artışı organik mi, yoksa wash-farming mi?"
- "Bu token'ın likidite yapısı rug riski taşıyor mu?"
- "Bu DAO teklifi hazineye net pozitif mi?"
- "Bu adres kümesi tek bir aktöre mi ait?"

Hiçbir oracle bunları resolve edemez — SKC'nin tam ihtiyacı. Ama agent'lar The Graph verisiyle akıl yürütebilir — The Graph track'inin tam ihtiyacı. **Tek ürün kararı iki track'i birbirine bağlıyor.**

### 3.3 Roller

| Rol | Kim | Demo'da |
|---|---|---|
| Soru soran | Herkes | **Açık.** Jüri kendi cüzdanıyla soru sorabilir |
| Katılımcı agent | Kayıtlı agent'lar | 20 agent, hepsi bizim |
| Referans agent | Marketin son agent'ı | Rastgele durma belirler |
| Protokol | Kontratlar + orchestrator | — |

**Kritik:** Agent kaydı kodda herkese açık kalır. Biz sadece havuzu kendi agent'larımızla tohumluyoruz. "Bütün agent'lar bizim" varsayımı KODA GÖMÜLMEZ.

### 3.4 Uçtan uca akış

```
1. Soru soran soruyu yazar, deposit yatırır, market açılır
   └─ Parametreler: k, T, α, bond miktarı (protokol aralığında)

2. Bonding window açılır (süreli)
   └─ İsteyen agent bond yatırıp havuza girer
   └─ Window kapanışında N ≥ N_min kontrolü, sağlanmazsa full refund

3. Market başlar. Her turda:
   a. Kalan bond'lu agent'lardan biri TAZE rastgelelikle çekilir
      (sıra ÖNCEDEN yayınlanmaz, tur tur çekilir)
   b. Agent kendi veri dilimini The Graph'tan çeker (x402 ile öder)
      + önceki tüm raporları okur
   c. Agent olasılık raporlar, rapor [ε, 1-ε]'e kırpılır
   d. Rapor HCS'e yazılır (sıralanmış, değiştirilemez log)
   e. HCS running hash'inden durma zarı türetilir
   f. Kapanmadıysa (a)'ya dön

4. Market kapanır
   └─ Son agent = referans agent, raporu = kapanış fiyatı r

5. Settlement (tek seferde, hepsi birden)
   └─ Agent 1..(r-k): S_CEM(r, q^t, q^(t-1)) ile ödenir
   └─ Son k agent: sabit ücret R
   └─ Negatif skorlar bond'dan kesilir → SORANA iade
   └─ Harcanmayan deposit → sorana iade
```

**Timeout durumu:** Çekilen agent süresinde cevap vermezse: bond slash + listeden düş + **o tur için durma zarı ATILMAZ**. Aksi halde timeout'lar marketi erken kapatır.

---

## 4. Nihai Mekanizma Ayarları

```
Havuz (N)                               20 kayıtlı agent
k                                       3      son 3 agent sabit ücret alır
T                                       5      ortalama 5 agent skorlanır
α                                       1/8    her rapordan sonra kapanma olasılığı
Beklenen market uzunluğu                8 agent rapor verir
Bir agent'ın sabit ücret alma ihtimali  %33
Havuz tükenme ihtimali                  %7.9
ε (kırpma)                              0.01
Referans                                marketin son agent'ı (tek, ortalama yok)
Rastgelelik kaynağı                     Hedera HCS running hash
```

### 4.1 Bu ayarların gerekçesi

Havuz N=20'de seçenek tablosu:

| k | T | α | Beklenen uzunluk | Skorlanan | P(tükenme) |
|---|---|---|---|---|---|
| **3** | **5** | **1/8** | **8** | **5** | **%7.9** |
| 3 | 4 | 1/7 | 7 | 4 | %5.3 |
| 4 | 5 | 1/9 | 9 | 5 | %10.7 |
| 6 | 5 | 1/11 | 11 | 5 | %16.4 |

**Bizim bulduğumuz, paper'da olmayan sonuç:** `α = 1/(T+k)` olduğu için k büyüdükçe α küçülür, market uzar, havuz tükenme ihtimali **artar**. Yani sonlu havuzda k'yı düşürmek iki eksende birden kazandırıyor: hem daha çok skorlanan agent hem daha az tükenme riski. Paper sonsuz havuz varsaydığı için bu trade-off'u hiç ele almıyor.

Grafikte 8 fiyat hareketi çıkıyor, 5 agent skorlanıyor. Demo için yeterince canlı.

### 4.2 Havuz tükenmesi analizi (bizim eklememiz)

Paper büyük havuz varsayıyor. Sonlu N ile:

```
P(pozisyon t'de referans olma) = α        (t < N için)
P(pozisyon N'de referans olma) = 1        (havuz tükendi)
P(havuz tükenir)               = (1-α)^(N-1)
```

Havuzun erimesi bilgi sızdırmıyor — 3 kişi kaldığında da olasılık hâlâ α. Sızıntı **sadece son pozisyonda** var. N=20, α=1/8 ile bu %7.9.

Demo'da bütün agent'lar bizim olduğu için bu sızıntı istismar edilmiyor. Tükenme olursa market zorla kapanır. README'de açıkça belirtilecek.

### 4.3 k=3'ün teorik bedeli

Teorem 1'in sapma sınırı (δ=0.5, η=0.1):

| k | Yalan kazancının üst sınırı \|Δ\| |
|---|---|
| 3 | 0.278 |
| 4 | 0.139 |
| 6 | 0.035 |

k=3'te sınır pratikte anlamsız hale geliyor. Agent'lar bizim olduğu ve stratejik davranmadığı için demoda etkisi yok.

**Çözüm: k'yı sabit sayı olarak gömme, protokol parametresi yap.** Repoya Teorem 1'i hesaplayan küçük bir hesaplayıcı koy. Bu, sabit 6 yazıp gerekçesiz bırakmaktan çok daha güçlü bir pozisyon.

---

## 5. Para Akışı — Kapalı Devre

Dışarıdan hiç para girmiyor. Soru soran ve agent'lar arasında kapanıyor.

**İçeri giren:**
- Soru soranın deposit'i `D`
- Agent bond'ları `N × B`

**Dışarı çıkan:**
- Sabit ücretler: `k × R`
- CEM ödemeleri: net toplam `≤ b · log2` (Bölüm 2.6)
- Bond iadeleri

**Deposit şartı:**

```
D ≥ b·log2 + k·R
```

**Kurallar:**

1. **Negatif CEM parası diğer agent'lara DAĞITILMAZ**, soruyu sorana iade edilir. Gerekçe: agent kârı rakibinin bond'undan değil, soranın ücretinden gelmeli. Bu, yapının skill-contest kategorisine kaymasını engelliyor.
2. **Harcanmayan deposit sorana iade edilir.**
3. **Market kapanmadan hiç kimseye ödeme yapılamaz**, çünkü herkesin skoru `r`'ye bağlı. Bond kapanışa kadar kilitli, settlement tek seferde.
4. **Slash edilen bond treasury'ye/sorana gider**, kazanan agent'a değil.

### 5.1 Bond boyutlandırma — pozisyon limiti yaklaşımı

ε=0.01 kırpmasıyla tek bir agent'ın en kötü kaybı `≈ b·log((1-ε)/ε) ≈ 4.6b`, oysa soranın toplam maksimum sübvansiyonu `b·log2 ≈ 0.69b`. Yani naif yaklaşımda bond, tüm marketin sübvansiyonunun ~6.6 katı olur. Agent'ın parası kilitlenir, kazancı küçük kalır, kimse katılmak istemez.

**Çözüm:** Bond'u giriş ücreti değil **pozisyon limiti** olarak kullan. Agent `q^(t)`'yi bond'unun taşıyabileceği kadar oynatabilsin, protokol raporu o aralığa kırpsın. Bond'un anlamı netleşiyor: ne kadar teminat koyarsan konsensüsü o kadar oynatabilirsin.

İlk sürümde tek tip bond + tek tip limit. Heterojen bond (zengin agent daha çok oynatır) gelecek çalışma olarak bırakılıyor — SKC'de bu tehlikeli bir manipülasyon vektörü.

---

## 6. Reddedilen Tasarımlar ve Gerekçeleri

Bu bölüm önemli: her biri ciddi ciddi değerlendirildi ve somut bir sebeple elendi.

### 6.1 Aynı agent birden fazla kez çekilsin (havuz tükenmesin)

**REDDEDİLDİ — self-dealing açığı.** Agent t anında rapor verip sonra referans agent olarak da çekilirse, kendi eski CEM skorunu maksimize eden referans raporu yazar. Her agent markete en fazla bir kez katılır.

### 6.2 Güvenilir k agent'ı sona yerleştir (paper §6.2 varyantı)

**REDDEDİLDİ — gereksiz.** Bu varyant, agent'ların dışarıdan geleceği ve sonlu havuzda son koltuğun sızıntı yaratacağı senaryoya karşı düşünülmüştü. Demo'da bütün agent'lar bizim olduğu için güvensizlik problemi yok, dolayısıyla paper'ın **asıl tercih ettiği tasarımı** (rastgele durma + terminal referans) doğrudan uygulayabiliyoruz.

Bu daha iyi çünkü sunumda "paper'ın alternatif varyantını uyguladık" yerine "paper'ı olduğu gibi uyguladık" diyorsun.

### 6.3 İnsan trader'lar / açık alım satım arayüzü

**REDDEDİLDİ — kapsam kararı.** Sadece agent'lar katılır. Bu hisse/pozisyon muhasebesini tamamen ortadan kaldırıyor, kontrat kodu ciddi şekilde azalıyor. Agent tahminini API'den gönderir, insanlar market sayfasını izler.

### 6.4 Sırayı window kapanışında toptan çekip yayınlama

**REDDEDİLDİ — bilgi sızıntısı.** Tüm sıra önceden yayınlanırsa, son sıradaki agent daha market başlamadan referans olacağını bilir. Referans sabit ücret aldığı için raporuna hiç emek harcamaz. Her turda taze rastgelelikle tek tek çekilecek.

### 6.5 Rolling window veya batch referans agent

**REDDEDİLDİ — paper Teorem 8.** Switching equilibrium oluşuyor, sonsuz ödeme, sınırsız AMM zararı. Ayrıca maliyet worst-case unbounded. Sabit terminal referans zorunlu.

### 6.6 Continuity havuzu

**REDDEDİLDİ — ödül üçte bire düşüyordu.** Bkz. Bölüm 1.1.

### 6.7 Paralel walled-off marketler

**REDDEDİLDİ — paper'ın kendi gerekçesi.** İki fiyat, her biri bilginin yarısını topluyor, verimsiz.

---

## 7. Agent Mimarisi

### 7.1 20 agent, gerçekten farklı

İşin can alıcı noktası: **her agent gerçekten farklı olmalı.** 20 agent da %72 derse demo ölü ve sahte görünür. Gerçekten farklı veriye bakıp gerçekten farklı sayılar söyleyip sonra yavaş yavaş yakınsarlarsa market canlı görünür.

Her agent'ın:
- Ayrı cüzdanı (Hedera hesabı)
- Ayrı ENS subname'i
- **Ayrı veri dilimi** (The Graph'tan farklı görünüm)
- Ayrı prompt/persona

Veri dilimi örnekleri:

| Agent tipi | Baktığı veri |
|---|---|
| Likidite analisti | Pool derinliği, LP dağılımı, likidite kilitleri |
| Holder analisti | Cüzdan dağılımı, konsantrasyon, yeni adres oranı |
| Köprü analisti | Zincirler arası akış, kaynak/hedef desenleri |
| İşlem deseni analisti | İşlem zamanlaması, gas desenleri, tekrar eden yollar |
| Karşılaştırmalı analist | Benzer protokollerle standardize şema üzerinden kıyas |

Bu ayrıştırma **Varsayım 4'ün (koşullu bağımsızlık) pratikteki karşılığı.** Mekanizmanın çalışma şartı, kozmetik bir çeşitlilik değil.

### 7.2 Maliyet

Çekilmeyen agent hiçbir maliyet üretmez. 20 agent kaydı tek seferlik. Bir markette sadece ~8 agent çalışır, yani market başına ~8 LLM çağrısı + ~8 veri sorgusu. Çok ucuz.

---

## 8. Sponsor Entegrasyonları

### 8.1 Hedera — para ve denetim

**Doğrulanmış teknik durum:**
- Blocky402 facilitator Hedera testnet destekliyor (Polygon Amoy, Solana Devnet, Hedera Testnet hosted testnet üzerinde; Hedera Mainnet hosted)
- npm paketleri: `@x402/hedera` (Hedera scheme), `@x402/fetch` (402 yanıtını otomatik işleyen fetch wrapper), `@x402/core/client`
- Akış: server 402 döner → client Hedera signer ile kısmi imzalı tx üretir → `X-PAYMENT` header ile retry → facilitator verify + settle
- Hedera "exact payment scheme" kullanıyor, partially signed transactions ile

**Kullanım alanları:**

1. **Ödeme rayı:** Soru soranın deposit'i, agent bond'ları, settlement dağıtımı.
2. **HCS = sıralanmış rapor log'u.** Bu süs değil: SKC'nin denge ispatı her agent'ın kendinden önceki TÜM raporları görmesine ve sıranın manipüle edilememesine dayanıyor. HCS consensus timestamp'i tam olarak bunu veriyor.
3. **HCS running hash = rastgelelik kaynağı.** Her rapor HCS'e yazılıyor ve servis her mesajdan sonra bir çalışan hash üretiyor. Bu hash mesaj gönderilmeden önce tahmin edilemiyor, gönderildikten sonra herkes doğrulayabiliyor. Durma zarını bundan türetiyoruz. Ekstra altyapı yok, harici beacon yok. *Production'da uygun bir VRF/drand önerilecek; bu demo için yeterli.*
4. **x402-gated servis:** Marketin çözümleme servisi dışarıya açılıyor — isteyen çağrı başına ödeyip bir soruya market fiyatını alabiliyor. Hedera track'inin "gerçek bir x402-gated servis ayağa kaldır **ve** onu tüketen platformu kur" şartı birebir bu.

### 8.2 The Graph — kanıt katmanı

**Doğrulanmış teknik durum:**
- Graph Gateway'de x402 USDC per-query **canlı**. Agent hiçbir API key, hesap veya session olmadan HTTP üzerinden sorgu satın alabiliyor.
- Gateway indexer'larla GraphTally üzerinden netleştiriyor (mikro ödeme toplulaştırma)
- Subgraph MCP mevcut: GraphQL şeması erişimi, deployment üzerinde sorgu çalıştırma, keyword/kontrat adresiyle top deployment keşfi, 30 günlük sorgu hacmi

**Kullanım:**
- Agent'ların bütün kanıtı buradan geliyor ve o kanıt **doğrudan paranın kime gideceğini belirliyor**
- Messari Standardized Subgraph ile tek sorgu deseni çok protokolde çalışıyor — bir agent "bu TVL artışı organik mi" sorusu için 5 protokolü tek şemadan tarayabiliyor
- Agent girdisi için öder (x402), çıktısı için ödeme alır. Track metninde özellikle istenen desen bu.

**Anlatım:** "Her agent'a farklı bir standardize şema görünümü atıyoruz, çünkü mekanizmanın matematiği sinyallerin koşullu bağımsızlığını gerektiriyor." Veri katmanı süs değil, dürüstlük garantisinin ön koşulu.

### 8.3 ENS — agent kimliği

**Doğrulanmış teknik durum:**
- ENSv2 Permissioned Registry, her isim ERC1155Singleton token
- Kendi subname registry'n: Verifiable Factory üzerinden UserRegistry proxy → `setParent()` → `grantRootRoles()` → `register(label, owner, registry, resolver, roleBitmap, expiry)`
- Roller: ROLE_REGISTRAR, ROLE_SET_RESOLVER, ROLE_SET_SUBREGISTRY, ROLE_UNREGISTER, ROLE_RENEW, ROLE_CAN_TRANSFER_ADMIN. Her rolün admin varyantı `role << 128`.

**KRİTİK KISIT:** İsim bazında **admin rolleri sadece registration anında** verilebiliyor. Registration'dan sonra sadece normal roller verilebilir. Yani agent subname'ini mint ederken skor record'unu kimin yazabileceğini o anda kilitlemek gerekiyor, sonradan düzeltilemez. **Rol şeması kod yazmadan önce kağıt üzerinde bitirilecek.**

Ayrıca rol değişiminde token id yeniden üretiliyor, bu eski approval'ları geçersiz kılıyor — slash/revoke akışında işe yarar.

**Kullanım:**
- Her agent `agentname.<parent>.eth` subname'i, kendi Permissioned Resolver'ı
- Text record'larda: model, endpoint, veri dilimi, katıldığı market sayısı, kümülatif kalibrasyon skoru
- Enhanced Access Control: agent kendi profil record'unu düzenleyebilir ama **skor record'unu düzenleyemez**, o rol orchestrator'da
- Süreli/iptal edilebilir subname: slash edilen agent'ın subname'i revoke edilir

**Sepolia adresleri dokümanda yok**, ENS deployments repo'sundan veya Discord'dan alınacak.

---

## 9. Track Seçimi

Maksimum 3 track hakkı var.

| Track | Ödül | Yapı |
|---|---|---|
| **Hedera — AI & Agentic Payments** | $6,000 | 3 takıma $2k |
| **The Graph — AI Use Case (From Scratch)** | $5,000 | 3 takıma |
| **ENS — Best Use of ENSv2** | $4,500 | 4 kazanan |

Üçünde de birden fazla kazanan var, toplam erişilebilir havuz ~$15.5k.

### 9.1 Elenen track'ler ve gerekçeleri

| Track | Neden elendi |
|---|---|
| Arc/Circle | Circle Agent Stack öğrenmek + 30 Eylül'e kadar Arc mainnet hazır olmak gerekiyor. Hedera x402 ile işlevsel olarak çakışıyor, jüriye "iki ödeme rayı neden" diye açıklamak zorunda kalırsın |
| Chainlink CRE | Confidential Workflows ilginç ama yeni bir runtime öğrenmek 3-4 gün yer, sadece 2 kazanan × $1k |
| Bazantic | Emek düşük ama ödül düşük, slot yakmaya değmez |
| World AgentKit | İnsan doğrulaması bu yapıda yapısal olarak gereksiz, zorlama olur |
| 1inch Aqua | Uyum yok |
| Uniswap | Uyum yok |
| Privy | Uyum yok |
| Ledger | Donanım gerektiriyor, uyum yok |

### 9.2 ENS notu

Başlangıçta ENS'in gerekçesi "agent kimliği = sybil savunması" idi. Referans agent'ın nasıl seçildiği değiştikçe bu gerekçe zayıfladı, ama ENS yine de tutuluyor: agent'ların kalıcı kimliği, geçmiş performansı ve keşfedilebilirliği gerçek bir ihtiyaç ve hackathon sonrası da kalıcı değer.

---

## 10. Demo Senaryoları

Agent'ları biz kontrol ettiğimiz için mekanizmanın kendini savunduğu anları **sahneleyebiliyoruz**. Dışarıdan agent olsaydı bu mümkün değildi.

### Senaryo 1 — Normal market
8 agent farklı veriye bakar, farklı sayılar söyler, fiyat oynar, son agent kapatır, ödemeler dağılır. Temel akış.

### Senaryo 2 — Yalancı agent
Bir agent kasten yanlış cevap verecek şekilde ayarlanır. Market onu düzeltir, o agent teminatından kaybeder. "Yalan söylemek pahalıya patlıyor" cümlesi yerine ekranda gösteriliyor.

### Senaryo 3 — Tembel agent'lar (EN GÜÇLÜ)
Hepsi bir öncekinin cevabını kopyalar. Ekranda herkesin kazancı **tam olarak sıfır** çıkar. Bu paper'ın Teorem 7'si, kanıtlanmış bir sonuç; canlı gösterilince çok etkileyici. "Hiçbir şey yapmadan para alma açığı yok" iddiası matematiksel değil görsel olarak kanıtlanıyor.

Bu videodaki en güçlü 30 saniye olacak.

### Senaryo 4 — Jüri kendi sorusunu sorar
Soru sorma tarafı tamamen açık. Jüri üyesi kendi cüzdanıyla gelir, kendi sorusunu sorar, parasını yatırır, agent'ların onun sorusu için canlı çalışmasını izler. Hedera'nın "en az bir gerçek ödemeli istek uçtan uca çalışsın" şartı da böyle karşılanıyor.

---

## 11. Zaman Planı

| Gün | İş | Track |
|---|---|---|
| 1 | Üç spike (Bölüm 12), repo iskeleti, monorepo (contracts / api / agent / web) | — |
| 2-3 | SKC çekirdeği: sıralı rapor, lazy draw, geometrik durma, CEM skorlama, flat-fee kuyruğu, ε kırpma. **Önce saf TypeScript + test, zincirsiz** | — |
| 4-5 | Hedera ödeme akışı uçtan uca: soran deposit → bond → settlement. HCS topic'e rapor yazımı | Hedera |
| 6 | HCS running hash'inden durma zarı türetimi + doğrulanabilirlik | Hedera |
| 7-8 | Agent runner: Graph Gateway'den kanıt çekme (x402 ile ödeme), veri dilimi ayrıştırması, kanıt→rapor pipeline | The Graph |
| 9-10 | ENS: registry deploy, 20 agent subname'i, resolver, rol şeması, skor yazımı | ENS |
| 11-12 | Frontend: market sayfası, canlı fiyat grafiği, agent kartları (ENS profilinden), settlement görünümü | Hepsi |
| 13 | 3 README + mimari diyagram. Her sponsor kendi kesitini net görmeli. k hesaplayıcısı | Hepsi |
| 14 | 3 demo videosu (Graph 2-4 dk, Hedera ≤5 dk, ENS live demo linki) + 4 senaryo kaydı | Hepsi |

**Sıra kasıtlı:** Hedera bitmezse diğer ikisi anlamsız. ENS en sonda çünkü en ucuz ve gerekirse kesilebilir tek parça.

---

## 12. Gün 1 Spike'ları — Kod Yazmadan Önce

Ürün kodunun tamamı bu üçünün çalıştığı varsayımı üstünde duruyor. Hepsi ayrı ayrı, hello-world seviyesinde, aynı gün doğrulanacak.

**1. Hedera x402**
Express'te tek korumalı endpoint, `@x402/hedera` ile testnet'ten ödeme, settlement header'ı oku. Tutmazsa Hedera track'i düşer, planın yarısı değişir.

**2. Graph x402**
Gateway'e API key'siz, x402 ile tek GraphQL sorgusu. Tutarsa "agent girdisi için öder" hikayesi gerçek olur; tutmazsa Studio API key'ine düşülür (track hâlâ geçerli ama hikaye zayıflar).

**3. ENSv2 Sepolia**
Bir UserRegistry deploy et, bir subname mint et, bir text record yaz. Adresleri bulmak muhtemelen kodu yazmaktan uzun sürecek.

Üçü de yeşilse plan aynen ilerler. Herhangi biri kırmızıysa **o günün akşamında** track değişimi konuşulur, 10. günde değil.

---

## 13. Riskler

| Risk | Etki | Azaltma |
|---|---|---|
| Blocky402 Hedera scheme'inin olgunluğu | Hedera track'i düşer | Gün 1 spike'ı |
| ENSv2 Sepolia adresleri dokümanda yok | ENS gecikir | Gün 1 spike'ı, ENS Discord |
| ENS admin rolleri sadece registration anında | Sonradan düzeltilemez | Rol şeması kod öncesi kağıtta bitirilecek |
| Agent'lar birbirine benzer cevap verir | Demo ölü görünür | Gerçekten farklı veri dilimleri, gün 7-8'de erken test |
| Graph gateway x402 rate limit / kota | Agent'lar veri çekemez | Fallback: Studio API key |
| Solo dev, 3 track, 2 hafta | Yetişmeme | ENS kesilebilir parça olarak en sonda |

---

## 14. Dürüstlük Beyanları — README ve Videoda

Bunlar saklanmayacak. Saklamaya çalışmak tek gerçek hata olur. Eksiklik gibi değil aşama gibi sunulacak.

**Agent operasyonu:**
> Protokol izinsiz katılıma açıktır, agent kaydı herkese açıktır. Bu demoda ağı biz tohumladık ve 20 agent'ı biz işletiyoruz. Soru sorma tarafı tamamen açıktır. Yol haritası: dış agent kaydının açılması, havuz büyüdükçe k'nın teorik değerine yükseltilmesi.

**k parametresi:**
> Teorem 1, varsaydığımız sinyal kalitesi için (δ=0.5, η=0.1, ε=0.05) k≈6 gerektiriyor. Demo, 20 agent'lık havuzla çalışabilirlik için k=3 ile koşuyor. k protokol parametresidir, havuz büyüdükçe yükseltilir. Repoda Teorem 1'i hesaplayan hesaplayıcı bulunmaktadır.

**Havuz tükenmesi:**
> Mekanizma durma zamanının tahmin edilemez olmasını gerektiriyor. Sonlu havuzda bu, son pozisyon hariç her yerde sağlanıyor. N=20, α=1/8 ile havuzun tükenme ihtimali %7.9; bu durumda market zorla kapanır. Demo'da bütün agent'lar bizim olduğu için bu durum istismar edilmiyor.

**Varsayım 4:**
> Paper agent sinyallerinin koşullu bağımsızlığını varsayıyor ve sonuç bölümünde bunu gevşetmeyi gelecek çalışma olarak işaret ediyor. Biz her agent'a farklı bir veri dilimi atayarak bu varsayıma yaklaşmaya çalışıyoruz, ama tam olarak sağlandığını iddia etmiyoruz.

**Efor:**
> Agent'ların efor sarf ettiğini kanıtlayan bir yapı yok. Paper'ın kendi sonuç bölümü bunu gelecek çalışma olarak işaret ediyor.

---

## 15. Uygulama Kontrol Listesi

Mekanizmanın doğru çalışması için ihlal edilmemesi gereken maddeler:

- [ ] Referans HER ZAMAN terminal agent. Rolling window / batch YOK.
- [ ] Raporlar [0.01, 0.99] aralığına kırpılıyor.
- [ ] Her agent markete en fazla BİR kez katılıyor (self-dealing engeli).
- [ ] Sıra önceden yayınlanmıyor, her turda taze rastgelelikle tek tek çekiliyor.
- [ ] Durma zarı HCS running hash'inden türetiliyor, doğrulanabilir.
- [ ] Timeout: bond slash + listeden düş + **o tur için durma zarı ATILMIYOR**.
- [ ] Bonding window kapanışında N ≥ N_min kontrolü, sağlanmazsa full refund.
- [ ] Settlement TEK SEFERDE, market kapanmadan hiç kimseye ödeme yok.
- [ ] Negatif CEM parası sorana iade, diğer agent'lara dağıtılmıyor.
- [ ] Slash edilen bond treasury'ye/sorana, kazanan agent'a değil.
- [ ] Deposit ≥ b·log2 + k·R kontrolü.
- [ ] k, T, α protokol parametresi, hardcode değil.
- [ ] Agent kaydı kodda herkese açık, "hepsi bizim" varsayımı gömülü değil.
- [ ] Her agent farklı veri dilimi, ayrı cüzdan, ayrı ENS subname.
- [ ] ENS rol şeması registration anında kilitleniyor (sonradan değiştirilemez).

---

## 16. Gelecek Çalışma (yol haritası slide'ı)

1. Dış agent kaydının açılması, havuzun 40+ agent'a büyümesi
2. k'nın teorik değerine (≈6) yükseltilmesi
3. Heterojen bond → pozisyon limiti farklılaşması
4. Referans agent ortalaması (paper §6.2, ödeme varyansını düşürür)
5. Efor/uzmanlık sinyalleme (paper'ın kendi gelecek çalışma önerisi)
6. AMM arayüzü (paper §6.3 eşdeğerliği zaten kanıtlı, hisse alım satımına açılabilir)
7. Production için uygun VRF/drand rastgelelik kaynağı

---

## Ek — Referanslar

- **Paper:** https://arxiv.org/abs/2306.04305
  (ar5iv tam metin: https://ar5iv.labs.arxiv.org/html/2306.04305)
- **Blocky402:** https://blocky402.com/ (docs: `/docs/`, quickstart: `/docs/quickstart/`)
- **Hedera x402 blog:** https://hedera.com/blog/hedera-and-the-x402-payment-standard/
- **Subgraph MCP:** https://thegraph.com/docs/en/subgraphs/tooling/subgraph-mcp/introduction/
- **Messari Standardized Subgraphs:** https://thegraph.com/docs/en/subgraphs/existing-subgraphs/standard-subgraphs/
- **ENSv2 Permissioned Registry:** https://docs.ens.domains/ensv2/permissioned-registry
- **ENSv2 Permissioned Resolver:** https://docs.ens.domains/ensv2/permissioned-resolver
- **ENSv2 Enhanced Access Control:** https://docs.ens.domains/ensv2/enhanced-access-control
- **Hedera Agent Kit:** https://github.com/hashgraph/hedera-agent-kit-js
- **x402 Protocol:** https://github.com/x402-foundation/x402
