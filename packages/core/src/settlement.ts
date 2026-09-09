/**
 * Settlement — kapanmış bir marketten ödemeleri hesaplar.
 *
 * Paper §6.2'deki maliyet formülü:
 *   `k·R - H(r, q^(r-k)) + H(r, q^(0))`
 *
 * Teleskoplama sayesinde CE-MSR tarafının toplamı `b·H(r, q^0)` ile sınırlı.
 * Uniform prior'la bu `b·log2`. Yani soru soranın maliyeti kanıtlanabilir
 * şekilde sınırlı ve bu `computeSettlement` içinde assert ediliyor.
 *
 * Dört muhasebe kuralı burada dayatılıyor:
 *   1. Toplam skorlu ödeme `b·H(r, prior)` aşamaz.
 *   2. Sabit ücret alan agent sayısı tam olarak `min(k, n)`.
 *   3. Negatif skordan kesilen para BAŞKA AGENT'A GİTMEZ, askere döner.
 *   4. Bir agent'ın kaybı teminatını aşamaz. Bu, rapor anındaki hamle limiti
 *      ile sağlanıyor (market.ts). Burada kırpma YAPILMAZ — kırpmak
 *      teleskoplamayı bozup 1. kuralı yok ediyor.
 *
 * Kural 3 teknik değil tasarımsal: agent kârı rakibinin teminatından değil,
 * soranın ücretinden gelmeli (PLAN.md Bölüm 5).
 */
import type { Belief, MarketParams, MarketState, Payout, Settlement } from './types.js';
import { maxTotalPayout, scoreCEM } from './scoring.js';

/** Kayan nokta karşılaştırma toleransı. */
const EPS_ACC = 1e-9;

/**
 * Soru soranın yatırması gereken minimum deposit.
 *
 *   `b · H_max(prior) + k · R`
 *
 * İlk terim CE-MSR tarafının teleskoplama üst sınırı, ikincisi sabit ücretler.
 * Uniform prior'la `b·log2 + k·R`.
 */
export function requiredDeposit(params: MarketParams, prior: Belief): number {
  return maxTotalPayout(params.b, prior) + params.k * params.R;
}

export interface SettlementOptions {
  /**
   * Soru soranın yatırdığı miktar. Verilmezse `requiredDeposit` kullanılır.
   */
  readonly deposit?: number;
}

/**
 * Kapanmış bir marketin ödemelerini hesaplar.
 *
 * Market `closed` durumunda olmalı. `cancelled` marketlerde settlement yoktur —
 * herkese tam iade yapılır ve bu çağrı reddedilir.
 */
export function computeSettlement(
  state: MarketState,
  opts: SettlementOptions = {},
): Settlement {
  if (state.status !== 'closed' && state.status !== 'settled') {
    throw new Error(
      `Settlement sadece kapanmış markette hesaplanır (durum: ${state.status}). ` +
        `'cancelled' marketlerde ödeme yoktur, herkese tam iade yapılır.`,
    );
  }

  const { params, prior, reports } = state;
  const { k, b, R, bondAmount } = params;
  const deposit = opts.deposit ?? requiredDeposit(params, prior);

  const n = reports.length;
  const reference = state.referenceReport?.belief;

  // --- teminat muhasebesi ---
  // Teminat yatıranlar: hiç çekilmeyenler + çekilenler (rapor verenler + timeout olanlar)
  const neverDrawn = state.bondedAgents.length;
  const drawn = state.drawnAgents.length;
  const timedOut = state.timedOutAgents.length;
  const reported = drawn - timedOut;
  const totalBondingAgents = neverDrawn + drawn;
  const totalBonds = totalBondingAgents * bondAmount;
  const timeoutSlash = timedOut * bondAmount;

  // --- ödemeler ---
  const payouts: Payout[] = [];
  let scoreSlash = 0;

  if (reference && n > 0) {
    // KURAL 2: son k agent sabit ücret alır. Skorlanan sayısı max(0, n-k).
    const scoredCount = Math.max(0, n - k);

    let prev: Belief = prior;
    for (let i = 0; i < n; i++) {
      const rep = reports[i]!;
      const position = i + 1;

      if (i < scoredCount) {
        const raw = scoreCEM(reference, rep.belief, prev);
        const amount = b * raw;

        // KURAL 4: kayıp teminatı aşamaz.
        //
        // Burada KIRPMA YAPILMIYOR. Kırpmak teleskoplamayı bozuyor: büyük bir
        // kayıp kırpılınca karşı taraftaki büyük kazancı dengeleyen para
        // kayboluyor ve fark soru sorana yıkılıyor, bütçe garantisi çöküyor.
        //
        // Bunun yerine hamle limiti rapor anında uygulanıyor (market.ts,
        // clipToAllowedMove). Buraya teminatı aşan bir kayıp gelirse market
        // hatalı bir hamleye izin vermiş demektir — sessizce düzeltmek yerine
        // gürültülü şekilde başarısız oluyoruz.
        if (amount < -bondAmount - EPS_ACC) {
          throw new Error(
            `${rep.agentId} (pozisyon ${position}) kaybı ${amount.toFixed(9)}, ` +
              `teminatı ${bondAmount}. Market teminatın taşımadığı bir hamleye ` +
              `izin vermiş — clipToAllowedMove atlanmış olmalı.`,
          );
        }
        if (amount < 0) scoreSlash += -amount;

        payouts.push({
          agentId: rep.agentId,
          position,
          kind: 'scored',
          amount,
          scoreRaw: raw,
        });
      } else {
        payouts.push({ agentId: rep.agentId, position, kind: 'flat-fee', amount: R });
      }
      prev = rep.belief;
    }
  }

  // --- toplamlar ---
  const scoreTotal = payouts.reduce((s, p) => s + p.amount, 0);
  const positiveTotal = payouts.reduce((s, p) => s + Math.max(0, p.amount), 0);

  // Teminat iadesi: timeout olanlar hariç herkes teminatını geri alır.
  const bondsReturned = (neverDrawn + reported) * bondAmount;

  // Agent'lara giden her şey.
  const totalToAgents = bondsReturned + scoreTotal;

  // KURAL 3: slash edilen para askere döner, başka agent'a değil.
  const askerRefund = deposit - positiveTotal + scoreSlash + timeoutSlash;

  const settlement: Settlement = {
    marketId: state.id,
    ...(reference ? { reference } : {}),
    payouts,
    deposit,
    totalBonds,
    scoreTotal,
    bondsReturned,
    timeoutSlash,
    scoreSlash,
    totalToAgents,
    askerRefund,
  };

  assertSettlementInvariants(settlement, state);
  return settlement;
}

/**
 * Muhasebe ve mekanizma değişmezlerini doğrular.
 *
 * Ayrı fonksiyon: hem `computeSettlement` içinde çağrılıyor hem de testlerde
 * ve zincir tarafında (ADIM 16) bağımsız olarak kullanılabiliyor.
 */
export function assertSettlementInvariants(s: Settlement, state: MarketState): void {
  const { params, prior } = state;
  const problems: string[] = [];

  // DEĞİŞMEZ 1 — bütçe sınırı (teleskoplama)
  if (s.reference) {
    const scored = s.payouts.filter((p) => p.kind === 'scored');
    const scoredTotal = scored.reduce((a, p) => a + p.amount, 0);
    const bound = maxTotalPayout(params.b, prior, s.reference);
    if (scoredTotal > bound + EPS_ACC) {
      problems.push(
        `Bütçe sınırı aşıldı: skorlu ödemeler ${scoredTotal.toFixed(9)} > ` +
          `b·H(r, prior) = ${bound.toFixed(9)}. Teleskoplama bozulmuş demektir.`,
      );
    }
  }

  // DEĞİŞMEZ 2 — sabit ücret alan sayısı
  const flatCount = s.payouts.filter((p) => p.kind === 'flat-fee').length;
  const expectedFlat = Math.min(params.k, s.payouts.length);
  if (flatCount !== expectedFlat) {
    problems.push(`Sabit ücret alan sayısı ${flatCount}, beklenen ${expectedFlat}.`);
  }

  // DEĞİŞMEZ 3 — muhasebe kapanıyor
  const inflow = s.deposit + s.totalBonds;
  const outflow = s.totalToAgents + s.askerRefund;
  if (Math.abs(inflow - outflow) > EPS_ACC) {
    problems.push(
      `Muhasebe kapanmıyor: giriş ${inflow.toFixed(9)} != çıkış ${outflow.toFixed(9)} ` +
        `(fark ${(inflow - outflow).toFixed(9)}).`,
    );
  }

  // DEĞİŞMEZ 4 — soru soranın cebinden deposit'ten fazlası çıkmıyor
  //
  // askerRefund = deposit - pozitif + scoreSlash + timeoutSlash
  //             = b·log2 - netScored + timeoutSlash
  // netScored <= b·log2 (teleskoplama) olduğu için bu her zaman >= 0.
  //
  // Not: pozitif ödemelerin TOPLAMI deposit'i aşabilir — negatiflerle
  // dengelendiği için. Asıl garanti bu değil, askerRefund >= 0.
  if (s.askerRefund < -EPS_ACC) {
    problems.push(
      `Asker deposit'ten fazlasını ödüyor: iade ${s.askerRefund.toFixed(9)} < 0. ` +
        `Bütçe garantisi çökmüş demektir.`,
    );
  }

  // DEĞİŞMEZ 5 — hiçbir kayıp teminatı aşmıyor
  for (const p of s.payouts) {
    if (p.amount < -params.bondAmount - EPS_ACC) {
      problems.push(
        `${p.agentId} kaybı ${p.amount.toFixed(9)}, teminatı ${params.bondAmount}. ` +
          `Rapor anındaki hamle limiti (clipToAllowedMove) uygulanmamış olmalı.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Settlement değişmezleri ihlal edildi:\n  - ${problems.join('\n  - ')}`);
  }
}
