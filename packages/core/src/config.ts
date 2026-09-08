/**
 * Market parametreleri, varsayılanlar ve doğrulama.
 *
 * Parametre seçimlerinin gerekçesi PLAN.md Bölüm 4'te. Kısaca:
 * k=3 teorinin gerektirdiği ~6'nın altında, 20 agent'lık havuzla çalışabilirlik
 * için bilinçli seçildi ve README'de belgeleniyor. k protokol parametresidir,
 * havuz büyüdükçe yükseltilir.
 */
import type { Belief, MarketParams } from './types.js';

/** Uniform prior — `q^(0)`. */
export const UNIFORM_PRIOR: Belief = [0.5, 0.5];

/**
 * Demo yapılandırması (PLAN.md Bölüm 4).
 *
 *   N=20, k=3, T=5, alpha=1/8
 *   -> beklenen market uzunluğu 8 agent, 5'i skorlanır
 *   -> havuz tükenme ihtimali (1-1/8)^19 = %7.9
 *   -> bir agent'ın sabit ücret alma ihtimali 1-(1-1/8)^3 = %33
 */
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

/** `alpha = 1/(T+k)` — paper §6.1'in önerdiği ilişki. */
export function suggestedAlpha(T: number, k: number): number {
  return 1 / (T + k);
}

/**
 * Sonlu havuzda tükenme olasılığı: `(1-alpha)^(N-1)`.
 *
 * Paper büyük havuz varsayıyor. Sonlu N ile pozisyon t < N için referans olma
 * olasılığı tam olarak alpha; sadece son pozisyonda 1'e sıçrıyor. Yani sızıntı
 * yalnızca havuz tükendiğinde oluşuyor.
 */
export function poolExhaustionProbability(alpha: number, N: number): number {
  if (N < 1) return 1;
  return (1 - alpha) ** (N - 1);
}

/** Bir agent'ın sabit ücret grubuna düşme olasılığı: `1-(1-alpha)^k`. */
export function flatFeeProbability(alpha: number, k: number): number {
  return 1 - (1 - alpha) ** k;
}

export interface ValidationResult {
  readonly ok: boolean;
  /** Mekanizmayı bozan, düzeltilmesi zorunlu sorunlar. */
  readonly errors: readonly string[];
  /** Çalışır ama dikkat edilmesi gereken durumlar. */
  readonly warnings: readonly string[];
}

/** Havuz tükenme olasılığı bunun üstündeyse uyarı verilir. */
const EXHAUSTION_WARN_THRESHOLD = 0.1;

/**
 * Parametreleri doğrular.
 *
 * Hata ile uyarıyı ayırıyoruz: hata mekanizmayı bozar (k=0 ile referans agent
 * kendi kendini skorlar), uyarı ise çalışan ama riskli bir yapılandırmadır
 * (havuz sık tükeniyor).
 */
export function validateParams(p: MarketParams): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Number.isInteger(p.k) || p.k < 1) {
    errors.push(
      `k tam sayı ve >= 1 olmalı (verilen: ${p.k}). k=0 ise referans agent ` +
        `kendi raporuna göre skorlanır ve mekanizma çöker.`,
    );
  }
  if (!Number.isInteger(p.T) || p.T < 1) {
    errors.push(`T tam sayı ve >= 1 olmalı (verilen: ${p.T}). Skorlanan agent kalmaz.`);
  }
  if (!(p.alpha > 0 && p.alpha < 1)) {
    errors.push(
      `alpha (0, 1) aralığında olmalı (verilen: ${p.alpha}). ` +
        `alpha=0 market hiç kapanmaz, alpha=1 ilk rapordan sonra kapanır.`,
    );
  }
  if (!(p.epsilon > 0 && p.epsilon < 0.5)) {
    errors.push(
      `epsilon (0, 0.5) aralığında olmalı (verilen: ${p.epsilon}). ` +
        `epsilon=0 ile log(0)=-Inf, sınırsız skor üretilebilir.`,
    );
  }
  if (!(p.b > 0)) errors.push(`b > 0 olmalı (verilen: ${p.b}).`);
  if (!(p.R >= 0)) errors.push(`R >= 0 olmalı (verilen: ${p.R}).`);
  if (!(p.bondAmount > 0)) errors.push(`bondAmount > 0 olmalı (verilen: ${p.bondAmount}).`);

  if (!Number.isInteger(p.minPoolSize) || p.minPoolSize <= p.k + 1) {
    errors.push(
      `minPoolSize > k+1 olmalı (verilen: ${p.minPoolSize}, k=${p.k}). ` +
        `Aksi halde her markette havuz tükenir ve hiç kimse skorlanmaz.`,
    );
  }

  // Hatalar varsa türev hesaplar anlamsız olur.
  if (errors.length > 0) return { ok: false, errors, warnings };

  const suggested = suggestedAlpha(p.T, p.k);
  if (Math.abs(p.alpha - suggested) > 1e-9) {
    warnings.push(
      `alpha=${p.alpha.toFixed(4)}, ancak T=${p.T} ve k=${p.k} için paper'ın ` +
        `önerdiği değer 1/(T+k)=${suggested.toFixed(4)}. Beklenen market uzunluğu ` +
        `${(1 / p.alpha).toFixed(1)} agent olacak, hedeflenen ${p.T + p.k} değil.`,
    );
  }

  const exhaustion = poolExhaustionProbability(p.alpha, p.minPoolSize);
  if (exhaustion > EXHAUSTION_WARN_THRESHOLD) {
    warnings.push(
      `Havuz tükenme ihtimali %${(exhaustion * 100).toFixed(1)} ` +
        `(alpha=${p.alpha.toFixed(4)}, N=${p.minPoolSize}). Tükendiğinde son agent ` +
        `referans olduğunu bilir ve durma zamanının tahmin edilemezliği bozulur. ` +
        `Havuzu büyüt veya alpha'yı yükselt.`,
    );
  }

  return { ok: true, errors, warnings };
}

/** Doğrulamayı çalıştırır, hata varsa fırlatır. Uyarıları döndürür. */
export function assertValidParams(p: MarketParams): readonly string[] {
  const r = validateParams(p);
  if (!r.ok) {
    throw new Error(`Geçersiz market parametreleri:\n  - ${r.errors.join('\n  - ')}`);
  }
  return r.warnings;
}

/** Değer sonlu bir sayı mı. */
function isFinite_(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * İnancı normalize eder: negatifleri reddeder, toplamı 1'e getirir.
 *
 * Kırpma DEĞİLDİR — kırpma `scoring.ts` içindeki `clipBelief` ile yapılır.
 * Buradaki iş sadece geçerli bir olasılık dağılımı elde etmek.
 */
export function normalizeBelief(b: readonly [number, number]): Belief {
  const [p0, p1] = b;
  if (!isFinite_(p0) || !isFinite_(p1)) {
    throw new Error(`İnanç sonlu sayılardan oluşmalı, verilen: [${p0}, ${p1}]`);
  }
  if (p0 < 0 || p1 < 0) {
    throw new Error(`İnanç negatif olamaz, verilen: [${p0}, ${p1}]`);
  }
  const sum = p0 + p1;
  if (sum <= 0) {
    throw new Error(`İnancın toplamı pozitif olmalı, verilen: [${p0}, ${p1}]`);
  }
  return [p0 / sum, p1 / sum];
}

/** `P(Y=1)` değerinden inanç üretir. */
export function beliefFromProbability(p1: number): Belief {
  if (!isFinite_(p1) || p1 < 0 || p1 > 1) {
    throw new Error(`P(Y=1) [0,1] aralığında olmalı, verilen: ${p1}`);
  }
  return [1 - p1, p1];
}

/** İnancın `P(Y=1)` bileşeni. */
export function probabilityOfYes(b: Belief): number {
  return b[1];
}
