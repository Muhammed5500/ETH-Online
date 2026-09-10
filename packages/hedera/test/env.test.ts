import { describe, expect, it } from 'vitest';
import {
  agentCountFromEnv,
  hederaConfigFromEnv,
  parseNetwork,
  readEnv,
  treasuryFromEnv,
} from '../src/env.js';

describe('readEnv', () => {
  it('treats an empty value as absent', () => {
    // The SPIKE A trap: `KEY=` in .env yields '' and not undefined, so `??`
    // sails right past it and the caller gets an empty string.
    expect(readEnv({ K: '' }, 'K')).toBeUndefined();
    expect(readEnv({ K: '   ' }, 'K')).toBeUndefined();
    expect(readEnv({}, 'K')).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(readEnv({ K: '  0.0.1234  ' }, 'K')).toBe('0.0.1234');
  });

  it('keeps a real value intact', () => {
    expect(readEnv({ K: '0.0.1234' }, 'K')).toBe('0.0.1234');
  });
});

describe('parseNetwork', () => {
  it('defaults to testnet', () => {
    expect(parseNetwork(undefined)).toBe('testnet');
  });

  it('accepts the known networks, case insensitively', () => {
    expect(parseNetwork('TESTNET')).toBe('testnet');
    expect(parseNetwork('mainnet')).toBe('mainnet');
    expect(parseNetwork('previewnet')).toBe('previewnet');
    expect(parseNetwork('local')).toBe('local');
  });

  it('rejects anything else instead of quietly falling back', () => {
    expect(() => parseNetwork('mainnett')).toThrow(/HEDERA_NETWORK/);
  });
});

describe('hederaConfigFromEnv', () => {
  const good = {
    HEDERA_NETWORK: 'testnet',
    HEDERA_OPERATOR_ID: '0.0.1234',
    HEDERA_OPERATOR_KEY: '0xabc',
  };

  it('reads a complete configuration', () => {
    expect(hederaConfigFromEnv(good)).toEqual({
      network: 'testnet',
      operatorId: '0.0.1234',
      operatorKey: '0xabc',
    });
  });

  it('names the missing variable in the error', () => {
    expect(() => hederaConfigFromEnv({ ...good, HEDERA_OPERATOR_ID: '' })).toThrow(
      /HEDERA_OPERATOR_ID/,
    );
    expect(() => hederaConfigFromEnv({ ...good, HEDERA_OPERATOR_KEY: undefined })).toThrow(
      /HEDERA_OPERATOR_KEY/,
    );
  });

  it('defaults the network when it is not set', () => {
    const { HEDERA_NETWORK: _drop, ...rest } = good;
    expect(hederaConfigFromEnv(rest).network).toBe('testnet');
  });
});

describe('treasuryFromEnv', () => {
  it('is undefined before setup has run — that is a normal state', () => {
    expect(treasuryFromEnv({})).toBeUndefined();
    expect(treasuryFromEnv({ HEDERA_TREASURY_ID: '', HEDERA_TREASURY_KEY: '' })).toBeUndefined();
  });

  it('is undefined when only half of it is filled in', () => {
    expect(treasuryFromEnv({ HEDERA_TREASURY_ID: '0.0.9' })).toBeUndefined();
    expect(treasuryFromEnv({ HEDERA_TREASURY_KEY: '0xk' })).toBeUndefined();
  });

  it('reads a complete pair', () => {
    expect(treasuryFromEnv({ HEDERA_TREASURY_ID: '0.0.9', HEDERA_TREASURY_KEY: '0xk' })).toEqual({
      accountId: '0.0.9',
      privateKey: '0xk',
    });
  });
});

describe('agentCountFromEnv', () => {
  it('comes from configuration, with a fallback', () => {
    expect(agentCountFromEnv({ AGENT_COUNT: '20' })).toBe(20);
    expect(agentCountFromEnv({ AGENT_COUNT: '7' })).toBe(7);
    expect(agentCountFromEnv({})).toBe(20);
    expect(agentCountFromEnv({}, 5)).toBe(5);
  });

  it('rejects a value that is not a positive integer', () => {
    expect(() => agentCountFromEnv({ AGENT_COUNT: '0' })).toThrow(/AGENT_COUNT/);
    expect(() => agentCountFromEnv({ AGENT_COUNT: '-3' })).toThrow(/AGENT_COUNT/);
    expect(() => agentCountFromEnv({ AGENT_COUNT: '2.5' })).toThrow(/AGENT_COUNT/);
    expect(() => agentCountFromEnv({ AGENT_COUNT: 'yirmi' })).toThrow(/AGENT_COUNT/);
  });
});
