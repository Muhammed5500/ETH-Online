# ENS Rol Şeması — ADIM 23

Kod yazılmadan önce bitirilmesi gereken tasarım. Sebebi ROADMAP'te büyük
harflerle: **isim bazında admin rolleri yalnız registration anında
verilebiliyor.** Yanlış şemayla 20 subname mint edilirse hepsi baştan yapılır.

Buradaki sabitlerin hepsi kaynaktan okundu, dokümandan değil:
`ensdomains/contracts-v2`, `main` dalı, 2026-09-11 tarihli hali.

- `contracts/src/registry/libraries/RegistryRolesLib.sol`
- `contracts/src/resolver/libraries/PermissionedResolverLib.sol`
- `contracts/src/resolver/PermissionedResolver.sol`
- `contracts/src/registry/PermissionedRegistry.sol`
- `contracts/src/registry/UserRegistry.sol`

---

## 0. Neyi kanıtlamaya çalışıyoruz

ENS burada bir etiket değil. İki iddianın taşıyıcısı:

1. **İsmin arkasındaki şey, raporun arkasındaki şeyle aynı.** Agent'ın Hedera
   hesabı ve ENS isminin sahibi aynı secp256k1 anahtarından türüyor. Rapor
   imzasını atan anahtar ile ismi kontrol eden anahtar aynı; köprü yok,
   eşleştirme tablosu yok.

2. **Sicil, agent'ın kendi beyanı değil.** Agent kendi profilini yazabiliyor,
   kendi skorunu yazamıyor. Bu ayrım ENSv2'nin Enhanced Access Control'ünde
   kayıt anahtarı düzeyinde uygulanabiliyor, bizim sözümüzle değil.

İkincisi olmadan ENS kozmetik olur: sicili biz yazıp biz okusaydık, zaten
API'mizden okumakla aynı şey olurdu.

---

## 1. Parent isim ne?

`<parent>.eth`, Sepolia'da ENSv2 üzerinde kayıtlı, deployer hesabına ait.
`.env` içinde `ENS_PARENT_NAME`.

Agent isimleri doğrudan bunun altında: `agent-07.<parent>.eth`.

Skor kayıtları **ayrı bir isim altında değil**, aynı ismin üzerinde ama farklı
kayıt anahtarlarında duruyor (bkz. bölüm 5). Ayrı dal kurmaya gerek kalmadı,
çünkü resolver yetkiyi anahtar bazında kapsayabiliyor.

## 2. Her agent subname'i kime ait?

Agent'ın kendi anahtarının EVM adresine. Türetme doğrulandı:

```
agent-01  hedera 0.0.10455278  ->  0x41d66b3ab8797f5dfd703cb5eae69663ef2ef573
agent-02  hedera 0.0.10455279  ->  0xc74dc26e97cc6f4b17fbcad458bfcf57de871cb4
```

Hedera hesapları ECDSA secp256k1 ile açıldığı için aynı anahtar hem Hedera
hesabını hem EVM adresini üretiyor. Sahiplik agent'ta, gas bizde: mint'i biz
ödüyoruz, agent'ların Sepolia'da ETH'i olmasına gerek yok.

## 3. Agent hangi kayıtları düzenleyebilecek?

Resolver tarafında, `authorizeTextRoles(name, key, agentAddress, true)` ile tek
tek verilen anahtarlar:

| Anahtar | İçerik |
|---|---|
| `description` | agent kendini nasıl tanımlıyor |
| `url` | varsa kendi sayfası |
| `avatar` | görsel |
| `model` | hangi modeli kullanıyor |
| `endpoint` | orchestrator'ın rapor isteyeceği adres |

`endpoint` bilerek agent'ta: kendi sunucusunu taşıyabilmeli. Bizim kayıt
defterimizdeki endpoint zaten imzalı bir kayıt gerektiriyor, buradaki de aynı
anahtara bağlı.

## 4. Agent hangi kayıtları düzenleyemeyecek?

| Anahtar | İçerik | Yazan |
|---|---|---|
| `score.markets` | katıldığı market sayısı | orchestrator |
| `score.reports` | verdiği rapor sayısı | orchestrator |
| `score.reference` | kaç kez referans oldu | orchestrator |
| `score.timeouts` | kaç kez cevap vermedi | orchestrator |
| `score.net` | net ödeme, mekanizma birimi | orchestrator |
| `hedera.account` | bond ödediği ve ödeme aldığı hesap | orchestrator |
| `slices` | okuduğu veri dilimleri | orchestrator |

`slices` ve `hedera.account` de orchestrator tarafında, çünkü ikisi de
mekanizmanın gördüğü gerçekle eşleşmeli. Agent kendi dilim listesini
değiştirebilseydi sicil, katıldığı marketlerde okuduğu veriyle çelişebilirdi.

## 5. Bu ayrım hangi yapıyla sağlanıyor?

**Seçilen: tek resolver, anahtar bazında yetki.** İki ayrı resolver'a gerek
yok, çünkü `PermissionedResolver` yetkiyi `resource(namehash, part)` ile
kapsıyor ve `part`, text anahtarının hash'i:

```solidity
function authorizeTextRoles(bytes calldata toName, string calldata key,
                            address account, bool grant) external returns (bool)
// resource(node, partHash(key)) uzerinde ROLE_SET_TEXT
```

Yani `agent-07.<parent>.eth` isminde `description` için agent'a
`ROLE_SET_TEXT`, `score.net` için hiçbir şey. Agent `score.net` yazmayı
denerse işlem revert eder.

**Reddedilen A — iki resolver.** İsmin tek resolver'ı olabiliyor; skoru başka
resolver'a koymak ayrı isim gerektirirdi. Anahtar bazında yetki varken gereksiz
karmaşıklık.

**Reddedilen B — skoru `score.agent-07.<parent>.eth` altına koymak.** Çalışırdı
ama agent kendi isminin altına subname mint edebilseydi geri alabilirdi;
edemesin diye ayrıca rol kısıtlamak gerekirdi. Tek isim daha az yüzey.

## 6. Slash edilen agent'ın ismi nasıl iptal edilir?

`ROLE_UNREGISTER` bizim UserRegistry'mizin kök kaynağında (root resource)
orchestrator'da durur. Agent'ın kendi isminde bu rol **yoktur**, yani kendi
kaydını silemez ve sicilinden kaçamaz.

İptal politikası: tek bir timeout iptal sebebi değil (mekanizma zaten
teminatını yakıyor). İsim ancak agent kalıcı olarak devre dışıysa geri
alınıyor. Bu bir protokol kuralı değil, bu dağıtımın operasyon kararı ve
README'de öyle yazılacak.

## 7. Expiry var mı?

Var: mint anında **90 gün**. Yenileme `ROLE_RENEW` ile orchestrator'da.

Gerekçe: terk edilmiş agent kimlikleri süresiz durmasın. `expiry = 0` süresiz
demek ve bunu istemiyoruz — hackathon sonrası ayakta kalan bir isim listesinin
sicili yanıltıcı olur.

## 8. `roleBitmap` tam olarak ne olacak?

Gerçek sabitler:

```solidity
ROLE_REGISTRAR        = 1 << 0     ROLE_SET_SUBREGISTRY = 1 << 20
ROLE_SET_PARENT       = 1 << 8     ROLE_SET_RESOLVER    = 1 << 24
ROLE_UNREGISTER       = 1 << 12    ROLE_SET_URI         = 1 << 36
ROLE_RENEW            = 1 << 16    ROLE_CAN_NAME        = 1 << 120
her rolün admin hali:  ROLE_X_ADMIN = ROLE_X << 128
ROLE_CAN_TRANSFER_ADMIN = (1 << 28) << 128
```

**Agent'a registry tarafında verilen: `roleBitmap = 0`.**

Neden sıfır, tek tek:

| Rol | Verilmiyor, çünkü |
|---|---|
| `ROLE_SET_RESOLVER` | **En kritik olanı.** Agent resolver'ı değiştirebilseydi ismi tamamen kendi kontrolündeki bir resolver'a yönlendirir ve kendi skorunu yazardı. Bütün 4. bölüm çöker |
| `ROLE_SET_SUBREGISTRY` | kendi altına registry takıp alt isimler üretmesine gerek yok, gereksiz yüzey |
| `ROLE_REGISTRAR` | kendi altına isim mint etmesi gerekmiyor |
| `ROLE_UNREGISTER` | kendi kaydını silip sicilinden kaçamamalı (bölüm 6) |
| `ROLE_RENEW` | süreyi uzatma kararı bizde |
| `ROLE_SET_PARENT` | ismin ağaçtaki yerini değiştirememeli |
| `ROLE_CAN_TRANSFER_ADMIN` | ismi devredememeli: kimlik anahtara bağlı, devir "raporu imzalayan anahtarla ismin sahibi aynı" değişmezini bozar |

Agent'ın yapabildiği her şey resolver tarafında ve `authorizeTextRoles` ile tek
tek veriliyor. Sahiplik (ERC1155 token) agent'ta, yetkiler ölçülü.

**Orchestrator'da (UserRegistry kök kaynağı):** `ROLE_REGISTRAR`,
`ROLE_REGISTRAR_ADMIN`, `ROLE_UNREGISTER`, `ROLE_UNREGISTER_ADMIN`,
`ROLE_RENEW`, `ROLE_RENEW_ADMIN`, `ROLE_SET_RESOLVER`, `ROLE_SET_RESOLVER_ADMIN`.

---

## Mint etmeden önce tek bir isimle doğrulanacaklar

ADIM 4 spike'ı hiç koşulmadı, yani bu API'ye repoda hiç dokunulmadı. 20 ismi
mint etmeden önce **tek bir deneme ismiyle** şunlar doğrulanacak, çünkü
yanlışsa hepsi baştan:

1. `roleBitmap = 0` ile mint edilen bir ismin sahibi gerçekten resolver'ı
   değiştiremiyor mu (`setResolver` revert ediyor mu).
2. `ROLE_CAN_TRANSFER_ADMIN` verilmediğinde token transferi gerçekten
   engelleniyor mu, yoksa transfer varsayılan olarak serbest mi.
3. `authorizeTextRoles` ile verilen anahtar bazında yetki, gerçekten yalnız o
   anahtarı yazdırıyor mu; `score.net` denemesi revert ediyor mu.
4. 90 günlük expiry ile mint çalışıyor mu.

Bu dört kontrol geçmeden 20 isim mint edilmeyecek. Kanıtları step-log'a
işlem hash'leriyle yazılacak.
