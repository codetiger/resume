import { describe, it, expect } from 'vitest';
import { decodePhone } from './contact';

describe('decodePhone', () => {
  it('formats a 10-digit number as a +91 pair', () => {
    expect(decodePhone('9940177422')).toBe('+91 99401 77422');
  });

  it('returns empty for non-numeric, zero, or negative input', () => {
    expect(decodePhone('')).toBe('');
    expect(decodePhone('abc')).toBe('');
    expect(decodePhone('0')).toBe('');
    expect(decodePhone('-5')).toBe('');
  });
});
