/**
 * Test yardımcıları — deterministik rastgelelik kaynakları.
 *
 * Üretimde durma zarı Hedera HCS running hash'inden türetiliyor (ADIM 14).
 * Testte tekrarlanabilirlik için bu iki kaynak kullanılır.
 *
 * ADIM 8'de tanımlanacak RandomSource arayüzü ile uyumludur:
 *   interface RandomSource { next(label: string): number }
 */

/** mulberry32 — küçük, hızlı, tekrarlanabilir PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seed'li ardışık kaynak. Aynı seed -> aynı dizi.
 * `label` sadece hata ayıklama için kaydedilir, akışı değiştirmez.
 */
export class SeededRandom {
  private readonly rng: () => number;
  readonly log: Array<{ label: string; value: number }> = [];

  constructor(seed: number) {
    this.rng = mulberry32(seed);
  }

  next(label: string): number {
    const value = this.rng();
    this.log.push({ label, value });
    return value;
  }
}

/**
 * Önceden yazılmış değerleri sırayla döndürür.
 * State machine testlerinde "tam olarak 5. rapordan sonra kapan" gibi
 * senaryoları kurmak için kullanılır. Değerler bitince hata fırlatır —
 * sessizce rastgeleye düşmez, çünkü bu testi anlamsız kılar.
 */
export class ScriptedRandom {
  private i = 0;
  readonly log: Array<{ label: string; value: number }> = [];

  constructor(private readonly values: readonly number[]) {}

  next(label: string): number {
    if (this.i >= this.values.length) {
      throw new Error(
        `ScriptedRandom tükendi: ${this.values.length} değer verildi, ` +
          `${this.i + 1}. istendi (label="${label}"). ` +
          `Test senaryosu beklenenden uzun koşuyor.`,
      );
    }
    const value = this.values[this.i++]!;
    this.log.push({ label, value });
    return value;
  }

  get consumed(): number {
    return this.i;
  }
}

/**
 * Etikete göre değer döndürür — sıraya değil.
 *
 * `ScriptedRandom` diziye dayandığı için tüketim sırası değişince hizası kayıyor.
 * Örnek: timeout bir `draw` tüketip `stop` tüketmiyor, dolayısıyla sonraki
 * çağrı dizide bir kayıyor ve testin niyeti bozuluyor.
 *
 * Bu kaynak `draw-*` ve `stop-*` etiketlerine ayrı sabitler döndürerek niyeti
 * doğrudan ifade ediyor: "hiç kapanmasın", "ilk agent'ı çek" gibi.
 */
export class LabelledRandom {
  readonly log: Array<{ label: string; value: number }> = [];

  /**
   * @param rules Etiket ön eki -> değer. En uzun eşleşen ön ek kazanır.
   * @param fallback Hiçbir kural eşleşmezse dönecek değer.
   */
  constructor(
    private readonly rules: Readonly<Record<string, number>>,
    private readonly fallback = 0.5,
  ) {}

  next(label: string): number {
    let best: string | undefined;
    for (const prefix of Object.keys(this.rules)) {
      if (label.startsWith(prefix) && (best === undefined || prefix.length > best.length)) {
        best = prefix;
      }
    }
    const value = best === undefined ? this.fallback : this.rules[best]!;
    this.log.push({ label, value });
    return value;
  }

  /** Belirli bir ön ekle kaç kez çağrıldı. */
  countOf(prefix: string): number {
    return this.log.filter((e) => e.label.startsWith(prefix)).length;
  }
}
