import { describe, it, expect } from 'vitest';
import { parseLayout, validateLayout } from './layout';

describe('parseLayout', () => {
  it('maps each glyph to the right cell def', () => {
    const [row] = parseLayout(['bn.x']);
    expect(row[0]).toEqual({ kind: 'base' });
    expect(row[1]).toEqual({ kind: 'disappear-normal' });
    expect(row[2]).toBeNull();
    expect(row[3]).toEqual({ kind: 'explosive' });
  });

  it('parses arrows, line sweeps, shifts and info', () => {
    const [row] = parseLayout(['><^v', 'rcti', '19..']);
    expect(parseLayout(['>'])[0][0]).toEqual({ kind: 'arrow', dir: 'right' });
    expect(parseLayout(['<'])[0][0]).toEqual({ kind: 'arrow', dir: 'left' });
    expect(parseLayout(['^'])[0][0]).toEqual({ kind: 'arrow', dir: 'back' });
    expect(parseLayout(['v'])[0][0]).toEqual({ kind: 'arrow', dir: 'forward' });
    expect(parseLayout(['r'])[0][0]).toEqual({ kind: 'disappear-line', sweepDir: 'row' });
    expect(parseLayout(['c'])[0][0]).toEqual({ kind: 'disappear-line', sweepDir: 'col' });
    expect(parseLayout(['t'])[0][0]).toEqual({ kind: 'shift', shiftId: 1 });
    expect(parseLayout(['3'])[0][0]).toEqual({ kind: 'shift', shiftId: 3 });
    expect(parseLayout(['i'])[0][0]).toEqual({ kind: 'info' });
    expect(row).toHaveLength(4);
  });

  it('throws on an unknown glyph', () => {
    expect(() => parseLayout(['nq'])).toThrow(/Unknown layout char/);
  });
});

describe('validateLayout', () => {
  it('accepts a well-formed board', () => {
    expect(() => validateLayout(['nbn', 'nnn'])).not.toThrow();
  });

  it('rejects ragged rows', () => {
    expect(() => validateLayout(['nbn', 'nn'])).toThrow(/ragged/);
  });

  it('requires exactly one base', () => {
    expect(() => validateLayout(['nnn', 'nnn'])).toThrow(/exactly one base/);
    expect(() => validateLayout(['nbn', 'nbn'])).toThrow(/exactly one base/);
  });

  it('rejects an empty layout', () => {
    expect(() => validateLayout([])).toThrow(/no rows/);
  });
});
