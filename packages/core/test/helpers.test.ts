import { describe, expect, it } from 'vitest';
import { ScriptedRandom, SeededRandom } from './helpers.js';

describe('SeededRandom', () => {
  it('aynı seed aynı diziyi üretir', () => {
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);
    const seqA = Array.from({ length: 20 }, (_, i) => a.next(`x${i}`));
    const seqB = Array.from({ length: 20 }, (_, i) => b.next(`x${i}`));
    expect(seqA).toEqual(seqB);
  });

  it('farklı seed farklı dizi üretir', () => {
    const a = new SeededRandom(1);
    const b = new SeededRandom(2);
    expect(a.next('x')).not.toBe(b.next('x'));
  });

  it('değerler [0,1) aralığında', () => {
    const r = new SeededRandom(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.next(`i${i}`);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('label akışı değiştirmez, sadece kaydedilir', () => {
    const a = new SeededRandom(9);
    const b = new SeededRandom(9);
    expect(a.next('draw-1')).toBe(b.next('stop-1'));
    expect(a.log[0]?.label).toBe('draw-1');
    expect(b.log[0]?.label).toBe('stop-1');
  });
});

describe('ScriptedRandom', () => {
  it('değerleri sırayla döndürür', () => {
    const r = new ScriptedRandom([0.1, 0.9, 0.5]);
    expect(r.next('a')).toBe(0.1);
    expect(r.next('b')).toBe(0.9);
    expect(r.next('c')).toBe(0.5);
    expect(r.consumed).toBe(3);
  });

  it('değerler bitince sessizce devam etmez, hata fırlatır', () => {
    const r = new ScriptedRandom([0.1]);
    r.next('a');
    expect(() => r.next('b')).toThrowError(/tükendi/);
  });
});
