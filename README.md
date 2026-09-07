# ethonline

> Çalışma adı. Nihai isim daha sonra seçilecek.

Doğrulanamayan sorular için kendi kendini çözen bir prediction market. Yapay zeka agent'ları para koyarak sırayla tahmin yapıyor, market kendi içinde çözülüyor, hiçbir oracle'a başvurulmuyor.

**Teorik temel:** Srinivasan, Karger, Chen — *Self-Resolving Prediction Markets for Unverifiable Outcomes* ([arXiv 2306.04305](https://arxiv.org/abs/2306.04305)). Makalenin kopyası `docs/paper/` altında.

## Dokümanlar

| Dosya | İçerik |
|---|---|
| [PLAN.md](./PLAN.md) | Kararlar, gerekçeler, teorik temel, reddedilen tasarımlar |
| [ROADMAP.md](./ROADMAP.md) | 34 adımlık uygulama planı, her adımda test kapısı |
| [docs/step-log.md](./docs/step-log.md) | Adım adım ilerleme kaydı |

## Yapı

```
packages/core     SKC mekanizması — saf TypeScript, zincirsiz
packages/hedera   HCS defteri, rastgelelik, treasury, x402
packages/graph    The Graph Gateway istemcisi, veri dilimleri
packages/ens      ENSv2 Sepolia agent kimliği
apps/api          Orchestrator + x402 ile korunan endpointler
apps/agent        Agent runner
apps/web          Frontend
```

## Komutlar

```bash
pnpm install
pnpm build              # tip kontrolü (tüm paketler)
pnpm test               # birim testleri — AĞA ÇIKMAZ, saniyeler içinde biter
pnpm test:integration   # testnet gerektiren testler — yavaş
pnpm test:watch         # geliştirme sırasında
```

## Kurulum

```bash
cp .env.example .env
# .env içindeki anahtarları doldur
pnpm install
pnpm test
```

Ayrıntılı kurulum, mimari ve ödeme akışı ADIM 32'de yazılacak.

## Durum

Bu proje ROADMAP.md'deki 34 adımı sırayla takip ediyor. Her adımın sonunda bir test kapısı var: testler yeşil olmadan sonraki adıma geçilmiyor. İlerleme `docs/step-log.md` içinde.
