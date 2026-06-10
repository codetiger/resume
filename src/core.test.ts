import { describe, it, expect } from 'vitest';
import { noise, clamp, easeInOutQuad, cellKey, parseCellKey, DIRECTION_DELTA } from './core';

describe('noise', () => {
  it('is deterministic for a seed', () => {
    expect(noise(42)).toBe(noise(42));
  });
  it('stays within [0, 1)', () => {
    for (let s = 0; s < 100; s++) {
      const n = noise(s * 1.37);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });
});

describe('clamp', () => {
  it('passes values inside the range through', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it('clamps to the bounds', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe('easeInOutQuad', () => {
  it('pins the endpoints and midpoint', () => {
    expect(easeInOutQuad(0)).toBe(0);
    expect(easeInOutQuad(1)).toBe(1);
    expect(easeInOutQuad(0.5)).toBeCloseTo(0.5, 10);
  });
  it('is monotonically non-decreasing', () => {
    let prev = -Infinity;
    for (let t = 0; t <= 1; t += 0.05) {
      const v = easeInOutQuad(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('cell keys', () => {
  it('round-trip through cellKey / parseCellKey', () => {
    expect(parseCellKey(cellKey(3, 7))).toEqual([3, 7]);
    expect(cellKey(0, 0)).toBe('0,0');
  });
});

describe('DIRECTION_DELTA', () => {
  it('maps each direction to its grid step', () => {
    expect(DIRECTION_DELTA.right).toEqual([1, 0]);
    expect(DIRECTION_DELTA.left).toEqual([-1, 0]);
    expect(DIRECTION_DELTA.forward).toEqual([0, 1]);
    expect(DIRECTION_DELTA.back).toEqual([0, -1]);
  });
});
