/**
 * Cross-entropy skorlama kuralları — paper Bölüm 4, Tanım 5 ve 7.
 *
 * Mekanizmanın matematiksel çekirdeği burası. İki değişmez bu dosyada
 * kanıtlanıyor ve ikisi de projenin geri kalanının dayandığı garanti:
 *
 *   1. Teleskoplama: Σ_t S_CEM(r, q^t, q^(t-1)) = S_CE(r, q^T) - S_CE(r, q^0)
 *   2. Bütçe sınırı:  toplam ödeme ≤ b·H(r, q^0)  (uniform prior ile b·log2)
 *
 * İkincisi soru soranın maliyetinin kanıtlanabilir şekilde sınırlı olmasını
 * sağlıyor. Bozulursa market sınırsız para yakabilir.
 */
import type { Belief } from './types.js';

/**
 * İnancı `[eps, 1-eps]` aralığına kırpar.
 *
 * ZORUNLU, kozmetik değil. Paper Ek C.2'deki switching equilibrium'un matematiği
 * tam olarak `log(0) = -∞`: kırpma olmadan tek bir agent `q -> 0` yazarak
 * sınırsız negatif (veya karşı tarafta sınırsız pozitif) skor üretebilir ve
 * teminat hiçbir zaman yetmez.
 *
 * İkili sonuçta `p1`'i kırpıp `p0 = 1 - p1` almak toplamı 1'de tutuyor,
 * ayrıca normalize etmeye gerek kalmıyor.
 */
export function clipBelief(b: Belief, epsilon: number): Belief {
  if (!(epsilon > 0 && epsilon < 0.5)) {
    throw new Error(`epsilon (0, 0.5) aralığında olmalı, verilen: ${epsilon}`);
  }
  const p1 = Math.min(1 - epsilon, Math.max(epsilon, b[1]));
  return [1 - p1, p1];
}

/** İnancın skorlamaya girmeye uygun olduğunu doğrular. */
function assertScorable(b: Belief, name: string): void {
  const [p0, p1] = b;
  if (!Number.isFinite(p0) || !Number.isFinite(p1)) {
    throw new Error(`${name} sonlu olmalı, verilen: [${p0}, ${p1}]`);
  }
  if (p0 <= 0 || p1 <= 0) {
    throw new Error(
      `${name} bileşenleri kesin pozitif olmalı, verilen: [${p0}, ${p1}]. ` +
        `Skorlamadan önce clipBelief uygulanmalı — log(0) sınırsız skor üretir.`,
    );
  }
}

/**
 * Çapraz entropi: `H(r, q) = -Σ_i r_i · log(q_i)`.
 *
 * `r` referans agent'ın raporu, `q` skorlanan agent'ın raporu.
 */
export function crossEntropy(r: Belief, q: Belief): number {
  assertScorable(q, 'q');
  return -(r[0] * Math.log(q[0]) + r[1] * Math.log(q[1]));
}

/**
 * Negatif çapraz entropi skorlama kuralı (Tanım 5):
 *   `S_CE(r, q) = -H(r, q) = Σ_i r_i · log(q_i)`
 *
 * Sabit `r` için `q = r`'de maksimum. Ama agent `r`'yi bilmiyor, bu yüzden
 * beklentisini maksimize ediyor ve optimum `q = E[r]`'de oluşuyor.
 */
export function scoreCE(r: Belief, q: Belief): number {
  return -crossEntropy(r, q);
}

/**
 * Cross-entropy market scoring rule (Tanım 7) — asıl ödeme kuralı:
 *
 *   `S_CEM(r, q^t, q^(t-1)) = -H(r, q^t) + H(r, q^(t-1)) = Σ_i r_i · log(q^t_i / q^(t-1)_i)`
 *
 * Agent, marketi kendinden önceki fiyattan kendi raporuna taşıdığı için
 * ödeniyor. Doğru yöne taşırsa pozitif, yanlış yöne taşırsa negatif alıyor.
 *
 * Ölçeklenmemiş ham değer döner; `b` çarpanını çağıran uygular.
 */
export function scoreCEM(r: Belief, qT: Belief, qPrev: Belief): number {
  assertScorable(qT, 'q^t');
  assertScorable(qPrev, 'q^(t-1)');
  return r[0] * Math.log(qT[0] / qPrev[0]) + r[1] * Math.log(qT[1] / qPrev[1]);
}

/**
 * Kullback-Leibler ıraksaması: `KL(p || q) = Σ_i p_i · log(p_i / q_i)`.
 *
 * Paper Teorem 7'de gerekiyor: bilgisiz dengede ilk agent tam olarak
 * `KL(r || q^(0))` alıyor, geri kalan herkes sıfır.
 */
export function kl(p: Belief, q: Belief): number {
  assertScorable(p, 'p');
  assertScorable(q, 'q');
  let sum = 0;
  for (let i = 0; i < 2; i++) {
    const pi = p[i]!;
    if (pi > 0) sum += pi * Math.log(pi / q[i]!);
  }
  return sum;
}

/**
 * Bir rapor dizisinin toplam CE-MSR ödemesi.
 *
 * Teleskoplama sayesinde ara terimler sadeleşiyor:
 *   `Σ_t S_CEM(r, q^t, q^(t-1)) = S_CE(r, q^son) - S_CE(r, q^0)`
 *
 * Bu, soru sorana kesin bir maliyet sınırı veriyor (bkz. `maxTotalPayout`).
 */
export function totalCEM(r: Belief, prior: Belief, reports: readonly Belief[]): number {
  if (reports.length === 0) return 0;
  const last = reports[reports.length - 1]!;
  return scoreCE(r, last) - scoreCE(r, prior);
}

/**
 * Bir hamlenin en kötü durumdaki kaybı.
 *
 * `S_CEM(r, q, qPrev) = Σ_i r_i · log(q_i / qPrev_i)` ifadesi `r`'de DOĞRUSAL,
 * dolayısıyla simpleks üzerindeki minimumu bir köşede:
 *
 *   `min_r S_CEM = min_i log(q_i / qPrev_i)`
 *
 * Yani agent, referansın ne çıkacağını bilmeden, en kötü ihtimalle bu kadar
 * kaybedebilir.
 */
export function worstCaseLoss(b: number, qT: Belief, qPrev: Belief): number {
  assertScorable(qT, 'q^t');
  assertScorable(qPrev, 'q^(t-1)');
  return -b * Math.min(Math.log(qT[0] / qPrev[0]), Math.log(qT[1] / qPrev[1]));
}

/**
 * Teminatın izin verdiği hamle aralığı — `[minP1, maxP1]`.
 *
 * NEDEN GEREKLİ: settlement'ta kaybı teminat seviyesinde kırpmak teleskoplamayı
 * bozuyor. Büyük bir kayıp kırpılınca karşı taraftaki büyük kazancı dengeleyen
 * para ortadan kalkıyor ve fark soru sorana yıkılıyor — bütçe garantisi çöküyor.
 *
 * Çözüm sorunu settlement'ta yamalamak değil, rapor anında ENGELLEMEK: agent
 * fiyatı teminatının taşıyabileceğinden fazla oynatamaz. O zaman kayıp zaten
 * teminatı aşamaz, kırpmaya gerek kalmaz, teleskoplama korunur.
 *
 * `worstCaseLoss ≤ bond` koşulundan, `c = e^(-bond/b)` ile:
 *   `q_1 ≥ qPrev_1 · c`  ve  `q_0 ≥ qPrev_0 · c`
 * ikincisi `q_1 ≤ 1 - (1 - qPrev_1) · c` demek.
 *
 * Bond'un anlamı böylece netleşiyor: ne kadar teminat koyarsan konsensüsü o
 * kadar oynatabilirsin (PLAN.md Bölüm 5.1).
 */
export function moveLimits(
  qPrev: Belief,
  b: number,
  bondAmount: number,
  epsilon: number,
): { readonly minP1: number; readonly maxP1: number } {
  assertScorable(qPrev, 'q^(t-1)');
  if (!(b > 0)) throw new Error(`b > 0 olmalı, verilen: ${b}`);
  if (!(bondAmount > 0)) throw new Error(`bondAmount > 0 olmalı, verilen: ${bondAmount}`);

  const c = Math.exp(-bondAmount / b);
  const lo = Math.max(epsilon, qPrev[1] * c);
  const hi = Math.min(1 - epsilon, 1 - (1 - qPrev[1]) * c);

  // Teminat çok küçükse aralık kapanabilir; o durumda hamle yok demektir.
  if (lo > hi) {
    const mid = Math.min(1 - epsilon, Math.max(epsilon, qPrev[1]));
    return { minP1: mid, maxP1: mid };
  }
  return { minP1: lo, maxP1: hi };
}

/** Raporu hem epsilon'a hem teminatın izin verdiği hamle aralığına kırpar. */
export function clipToAllowedMove(
  qT: Belief,
  qPrev: Belief,
  b: number,
  bondAmount: number,
  epsilon: number,
): Belief {
  const { minP1, maxP1 } = moveLimits(qPrev, b, bondAmount, epsilon);
  const p1 = Math.min(maxP1, Math.max(minP1, qT[1]));
  return [1 - p1, p1];
}

/**
 * Soru sorana düşen maksimum CE-MSR maliyeti: `b · H(r, q^0)`.
 *
 * Paper §6.2: maliyet `k·R - H(r, q^(r-k)) + H(r, q^(0))`. `H ≥ 0` olduğu için
 * CE-MSR tarafı `H(r, q^0)` ile sınırlı. Uniform prior'la bu `log 2 ≈ 0.693`.
 *
 * Referanstan bağımsız üst sınır istenirse `r` verilmez: uniform prior'da
 * `H(r, [0.5, 0.5]) = log 2` her `r` için aynıdır.
 */
export function maxTotalPayout(b: number, prior: Belief, r?: Belief): number {
  if (r) return b * crossEntropy(r, prior);
  // r bilinmiyorsa en kötü durum: H(r, prior) hangi r için maksimum?
  // H(r, prior) = -(r0·log p0 + r1·log p1), r simpleks üzerinde doğrusal,
  // yani maksimum köşede: max(-log p0, -log p1).
  return b * Math.max(-Math.log(prior[0]), -Math.log(prior[1]));
}
