import { describe, it, expect } from 'vitest';
import { resizeBox, resizeAnchor, scalePoints } from '../../src/core/shape-adapters';

describe('resizeBox', () => {
  const box = { x: 0, y: 0, width: 10, height: 10 };

  it('east handle grows width, ignores dy', () => {
    expect(resizeBox(box, 5, 3, 'e')).toEqual({ x: 0, y: 0, width: 15, height: 10 });
  });
  it('west handle moves x and shrinks width', () => {
    expect(resizeBox(box, 4, 0, 'w')).toEqual({ x: 4, y: 0, width: 6, height: 10 });
  });
  it('north handle moves y and shrinks height', () => {
    expect(resizeBox(box, 0, 4, 'n')).toEqual({ x: 0, y: 4, width: 10, height: 6 });
  });
  it('south handle grows height', () => {
    expect(resizeBox(box, 0, 4, 's')).toEqual({ x: 0, y: 0, width: 10, height: 14 });
  });
  it('corner (nw) moves both origin and size', () => {
    expect(resizeBox({ x: 10, y: 10, width: 10, height: 10 }, 2, 3, 'nw'))
      .toEqual({ x: 12, y: 13, width: 8, height: 7 });
  });
  it('does not clamp (raw box, even when inverted)', () => {
    expect(resizeBox(box, -20, 0, 'e')).toEqual({ x: 0, y: 0, width: -10, height: 10 });
  });
});

describe('resizeAnchor (fixed corner = opposite the dragged handle)', () => {
  const box = { x: 0, y: 0, width: 10, height: 10 };
  it('se handle anchors the nw corner', () => {
    expect(resizeAnchor(box, 'se')).toEqual({ fx: 0, fy: 0 });
  });
  it('nw handle anchors the se corner', () => {
    expect(resizeAnchor(box, 'nw')).toEqual({ fx: 10, fy: 10 });
  });
  it('e handle anchors the left edge', () => {
    expect(resizeAnchor(box, 'e')).toEqual({ fx: 0, fy: 0 });
  });
  it('n handle anchors the bottom edge', () => {
    expect(resizeAnchor(box, 'n')).toEqual({ fx: 0, fy: 10 });
  });
});

describe('scalePoints', () => {
  it('scales about the origin', () => {
    expect(scalePoints('0,0 10,0 10,10', 0, 0, 2, 2)).toBe('0,0 20,0 20,20');
  });
  it('scales about an arbitrary fixed point that stays put', () => {
    expect(scalePoints('10,10 20,10', 10, 10, 2, 1)).toBe('10,10 30,10');
  });
});
