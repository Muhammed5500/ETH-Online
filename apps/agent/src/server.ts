/**
 * The agent's HTTP face — what the orchestrator actually talks to.
 *
 * THE SIGNATURE IS THE WHOLE POINT OF THIS FILE. Reports are the one write
 * that is not paid for, so payment cannot prove who sent them; the agent signs
 * with the same Hedera key it bonded with. The canonical message is imported
 * from `@ethonline/api` rather than reimplemented here, and that is deliberate:
 * two copies of a byte-exact format drift the moment either side is touched,
 * and the failure is a 401 that looks like a key problem.
 *
 * WHAT IS SIGNED IS THE RAW PROBABILITY. Not the clipped one. The protocol
 * clips on receipt and stores both, which is what makes the clip auditable —
 * an agent that pre-clipped would erase the evidence that it ever wanted to go
 * further.
 *
 * FAILURES ANSWER, THEY DO NOT HANG. A model outage or a bad answer returns
 * 503 with a reason. The orchestrator treats any unusable answer as a timeout
 * and slashes the bond either way, so there is nothing to gain by stalling —
 * but an operator reading the logs should be able to tell a broken model from
 * a broken agent.
 */
import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import { PrivateKey } from '@hashgraph/sdk';
import {
  canonicalReportMessage,
  canonicalRegistrationMessage,
  registrationMessageBytes,
  reportMessageBytes,
  type RegistrationClaim,
} from '@ethonline/api';
import { beliefFromProbability, type Belief } from '@ethonline/core';
import type { Agent, AgentConfig, PriorReport } from './runner.js';

export interface AgentServerDeps {
  readonly agent: Agent;
  readonly config: AgentConfig;
}

export interface AgentServer {
  readonly app: Express;
  readonly agentId: string;
  /**
   * Unique to this process, published on `/health`.
   *
   * WHY AN IDENTITY AND NOT JUST A PORT. A stale agent process left listening
   * on the same port will answer for this one, and on Windows the second bind
   * can succeed rather than fail — so the fleet starts, reports every agent as
   * up, and the market is quietly served by whatever was running before. It
   * cost a whole run to find. A caller that can ask "is this you?" catches it
   * in a second; a port number cannot.
   */
  readonly instanceId: string;
}

/**
 * Parses a Hedera private key in whichever form the accounts file holds.
 *
 * `agents/accounts.json` stores DER, and `PrivateKey.fromStringECDSA` accepts
 * that as well as a bare hex key. The fallback exists because a key that fails
 * to parse at startup is far cheaper to diagnose than one that fails at the
 * moment the agent is drawn, which costs it the bond.
 */
export function parseAgentKey(raw: string): PrivateKey {
  try {
    return PrivateKey.fromStringECDSA(raw);
  } catch {
    return PrivateKey.fromStringDer(raw);
  }
}

/** Signs a report claim with the agent's key. Hex, no `0x`. */
export function signReport(
  key: PrivateKey,
  claim: { marketId: string; agentId: string; position: number; belief: Belief },
): string {
  // Throws on a malformed claim before anything is signed: a signature over
  // bytes that do not reproduce is a signature over nothing.
  canonicalReportMessage(claim);
  return Buffer.from(key.sign(reportMessageBytes(claim))).toString('hex');
}

function asHistory(raw: unknown): PriorReport[] {
  if (!Array.isArray(raw)) return [];
  const out: PriorReport[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const belief = r['belief'];
    if (!Array.isArray(belief) || belief.length !== 2) continue;
    const p0 = Number(belief[0]);
    const p1 = Number(belief[1]);
    if (!Number.isFinite(p0) || !Number.isFinite(p1)) continue;
    out.push({
      position: Number(r['position']) || out.length + 1,
      agentId: String(r['agentId'] ?? 'unknown'),
      belief: [p0, p1],
    });
  }
  return out;
}

function asPrior(raw: unknown): Belief {
  if (Array.isArray(raw) && raw.length === 2) {
    const p0 = Number(raw[0]);
    const p1 = Number(raw[1]);
    if (Number.isFinite(p0) && Number.isFinite(p1)) return [p0, p1];
  }
  return [0.5, 0.5];
}

export function createAgentServer(deps: AgentServerDeps): AgentServer {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const key = parseAgentKey(deps.config.privateKey);
  const instanceId = randomUUID();

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      agentId: deps.config.id,
      accountId: deps.config.accountId,
      sliceIds: deps.config.sliceIds,
      behavior: deps.agent.behavior,
      instanceId,
    });
  });

  app.post('/report', (req, res) => {
    void (async () => {
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<
        string,
        unknown
      >;

      const marketId = String(body['marketId'] ?? '');
      const question = String(body['question'] ?? '');
      const position = Number(body['position']);
      if (!marketId || !question || !Number.isInteger(position) || position < 1) {
        return void res.status(400).json({
          error: 'Invalid report request',
          detail: 'marketId, question and an integer position >= 1 are required.',
        });
      }

      let produced;
      try {
        produced = await deps.agent.produceReport({
          marketId,
          question,
          position,
          prior: asPrior(body['prior']),
          history: asHistory(body['history']),
        });
      } catch (e) {
        // The orchestrator will slash for this, and it should. Saying why
        // separates "the model is down" from "this agent is broken".
        return void res.status(503).json({
          error: 'Could not produce a report',
          detail: (e as Error).message,
        });
      }

      let signature: string;
      try {
        signature = signReport(key, {
          marketId,
          agentId: deps.config.id,
          position,
          belief: beliefFromProbability(produced.probability),
        });
      } catch (e) {
        return void res.status(500).json({
          error: 'Report could not be signed',
          detail: (e as Error).message,
        });
      }

      return void res.json({
        probability: produced.probability,
        signature,
        reasoning: produced.reasoning,
        sliceIds: produced.sliceIds,
        evidenceCostUsd: produced.evidenceCostUsd,
        evidenceDigest: produced.evidenceDigest,
      });
    })();
  });

  return { app, agentId: deps.config.id, instanceId };
}

/**
 * Signs a registration, so the API can check the key is really this agent's.
 *
 * Lives here rather than in the fleet script because it is part of the agent's
 * contract with the API, and a third party writing their own agent needs the
 * same three lines. The canonical message comes from `@ethonline/api` for the
 * same reason the report one does: two copies of a byte-exact format drift the
 * moment either side is touched, and the failure is a 401 that reads like a
 * key problem.
 */
export function signRegistration(key: PrivateKey, claim: RegistrationClaim): string {
  canonicalRegistrationMessage(claim);
  return Buffer.from(key.sign(registrationMessageBytes(claim))).toString('hex');
}
