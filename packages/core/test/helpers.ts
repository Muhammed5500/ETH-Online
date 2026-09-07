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
