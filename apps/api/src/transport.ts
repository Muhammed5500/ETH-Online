/**
 * Reaching agents over HTTP, and moving money on Hedera.
 *
 * Both are thin adapters behind the interfaces the orchestrator declares, so
 * the round loop and the settlement arithmetic stay testable without either.
 */
import { AccountId, Hbar, PrivateKey, TransferTransaction, type Client } from '@hashgraph/sdk';
import { withRetry } from '@ethonline/hedera';
import type {
  AgentReportResponse,
  AgentTransport,
  Payer,
  PayerReceipt,
  ReportRequest,
} from './orchestrator.js';
import type { RegisteredAgent } from './store.js';
import type { TransferLine } from './settlement-plan.js';

/**
 * Asks an agent for a report over HTTP.
 *
 * The deadline is enforced with an AbortSignal rather than a race against a
 * timer, so a slow agent's request is actually cancelled instead of being left
 * to arrive later and be discarded — the round has already moved on by then.
 *
 * WHAT COMES BACK BESIDES THE NUMBER. Only `probability` is scored, and only
 * `signature` is checked, but an agent also reports which slices it read, what
 * the evidence cost it and a digest of that evidence. None of it can move a
 * payout. It is carried anyway because it is the only place the cost of the
 * evidence is ever visible: drop it here and a market page can show what was
 * concluded but never what it took to conclude it.
 */
export function httpAgentTransport(): AgentTransport {
  return {
    async requestReport(agent: RegisteredAgent, req: ReportRequest): Promise<AgentReportResponse> {
      if (!agent.endpoint) {
        throw new Error(`Agent ${agent.agentId} has no endpoint registered.`);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.deadlineMs);
      try {
        const res = await fetch(agent.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            marketId: req.marketId,
            question: req.question,
            position: req.position,
            prior: req.prior,
            // The agent must see every earlier report: the equilibrium
            // argument assumes it does.
            history: req.history.map((r) => ({
              position: r.position,
              agentId: r.agentId,
              belief: r.belief,
            })),
          }),
        });
        if (!res.ok) {
          throw new Error(`Agent responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        const body = (await res.json()) as Partial<AgentReportResponse>;
        if (typeof body.probability !== 'number' || typeof body.signature !== 'string') {
          throw new Error('Agent response is missing "probability" or "signature".');
        }
        return {
          probability: body.probability,
          signature: body.signature,
          ...(typeof body.reasoning === 'string' ? { reasoning: body.reasoning } : {}),
          // Filtered rather than trusted: this is an agent's own account of
          // itself and arrives over the same untrusted channel as the rest.
          ...(Array.isArray(body.sliceIds)
            ? { sliceIds: body.sliceIds.filter((s): s is string => typeof s === 'string') }
            : {}),
          ...(typeof body.evidenceCostUsd === 'number' && Number.isFinite(body.evidenceCostUsd)
            ? { evidenceCostUsd: body.evidenceCostUsd }
            : {}),
          ...(typeof body.evidenceDigest === 'string'
            ? { evidenceDigest: body.evidenceDigest }
            : {}),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface HederaPayerOptions {
  readonly client: Client;
  readonly treasuryAccountId: string;
  readonly treasuryKey: string;
}

/**
 * Pays a settlement out of the treasury.
 *
 * One chunk of the plan becomes one `TransferTransaction`: the treasury debit
 * and every credit in that chunk settle together or not at all. Hedera caps
 * how many accounts a single transfer may touch, which is why a settlement of
 * twenty agents arrives as several transactions rather than one — see
 * `chunkPlan`.
 *
 * The transaction is frozen before the first attempt so a retry carries the
 * same transaction id and cannot pay twice (see `retry.ts`).
 */
export function hederaPayer(opts: HederaPayerOptions): Payer {
  const treasury = AccountId.fromString(opts.treasuryAccountId);
  const treasuryKey = PrivateKey.fromStringECDSA(opts.treasuryKey);

  return {
    async send(lines: readonly TransferLine[], memo: string): Promise<PayerReceipt> {
      const total = lines.reduce((sum, l) => sum + l.amountTinybar, 0n);
      if (total <= 0n) {
        throw new Error('Refusing to send an empty transfer.');
      }

      // `Hbar.fromTinybars` does not take a bigint, and going through Number
      // would silently lose precision above 2^53. Strings keep it exact.
      const tx = new TransferTransaction().addHbarTransfer(
        treasury,
        Hbar.fromTinybars((-total).toString()),
      );
      for (const line of lines) {
        tx.addHbarTransfer(
          AccountId.fromString(line.accountId),
          Hbar.fromTinybars(line.amountTinybar.toString()),
        );
      }
      tx.setTransactionMemo(memo.slice(0, 100));

      const frozen = await tx.freezeWith(opts.client).sign(treasuryKey);
      const { receipt, transactionId } = await withRetry(async () => {
        const response = await frozen.execute(opts.client);
        return { receipt: await response.getReceipt(opts.client), transactionId: response.transactionId };
      });

      return { transactionId: transactionId.toString(), status: receipt.status.toString() };
    },
  };
}
