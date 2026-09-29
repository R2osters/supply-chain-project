import {barToFrame, barAt, beatAt, beatPhase, quantize, roundHalfUp, TOTAL_FRAMES} from './beat';

describe('beat math', () => {
  it('maps bars and beats to frames', () => {
    expect(barToFrame(1)).toBe(0);
    expect(barToFrame(2)).toBe(60);
    expect(barToFrame(33, 1)).toBe(1920); // the S07 click
    expect(barToFrame(1, 3)).toBe(30);
    expect(barToFrame(1, 1, 2)).toBe(4); // 3.75 rounds half-up to 4
    expect(barToFrame(1, 1, 3)).toBe(8); // 7.5 -> 8
  });
  it('knows the total length', () => expect(TOTAL_FRAMES).toBe(5100));
  it('locates a frame', () => {
    expect(barAt(0)).toBe(1);
    expect(barAt(1919)).toBe(32);
    expect(barAt(1920)).toBe(33);
    expect(beatAt(127)).toBe(8);
    expect(beatPhase(127)).toBeCloseTo(7 / 15);
  });
  it('quantizes half-up', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-0.5)).toBe(0);
    expect(quantize(9, '16th')).toBe(8); // 9/3.75 = 2.4 -> 2 -> 7.5 -> 8
    expect(quantize(22, 'beat')).toBe(15);
    expect(quantize(23, 'beat')).toBe(30);
    expect(quantize(44, 'bar')).toBe(60);
  });
});
