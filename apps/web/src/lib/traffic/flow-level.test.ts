import { describe, expect, it } from 'vitest';
import {
  FREE_THRESHOLD,
  SLOW_THRESHOLD,
  flowBucket,
  flowDensityMult,
  flowSpeedScale,
} from './flow-level';

describe('flowBucket', () => {
  it('splits levels at the God Eye thresholds', () => {
    expect(flowBucket(1)).toBe('free');
    expect(flowBucket(FREE_THRESHOLD)).toBe('free');
    expect(flowBucket(0.84)).toBe('slow');
    expect(flowBucket(SLOW_THRESHOLD)).toBe('slow');
    expect(flowBucket(0.54)).toBe('jam');
    expect(flowBucket(0)).toBe('jam');
  });

  it('says "not measured" for missing or unusable levels, never a jam', () => {
    expect(flowBucket(null)).toBeNull();
    expect(flowBucket(undefined)).toBeNull();
    expect(flowBucket(Number.NaN)).toBeNull();
    expect(flowBucket(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('flowSpeedScale', () => {
  it('slows dots with the level but never freezes them', () => {
    expect(flowSpeedScale(1)).toBe(1);
    expect(flowSpeedScale(0.5)).toBe(0.5);
    expect(flowSpeedScale(0.05)).toBe(0.15);
    expect(flowSpeedScale(0)).toBe(0.15);
  });

  it('caps at free flow when a source reports a speed above the limit', () => {
    expect(flowSpeedScale(1.3)).toBe(1);
  });

  it('keeps unmeasured roads at their free speed', () => {
    expect(flowSpeedScale(null)).toBe(1);
    expect(flowSpeedScale(undefined)).toBe(1);
    expect(flowSpeedScale(Number.NaN)).toBe(1);
  });
});

describe('flowDensityMult', () => {
  it('packs more dots on slower roads, up to 2.5 times', () => {
    expect(flowDensityMult(1)).toBe(1);
    expect(flowDensityMult(0.5)).toBe(2);
    expect(flowDensityMult(0.4)).toBe(2.5);
    expect(flowDensityMult(0.1)).toBe(2.5);
    expect(flowDensityMult(0)).toBe(2.5);
  });

  it('leaves unmeasured roads at the base density', () => {
    expect(flowDensityMult(null)).toBe(1);
    expect(flowDensityMult(undefined)).toBe(1);
    expect(flowDensityMult(Number.NaN)).toBe(1);
  });
});
