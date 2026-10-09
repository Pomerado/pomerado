import { describe, expect, it } from "vitest";
import {
  clickTiming,
  humanPointerPath,
  pointerTarget,
  pointerTiming,
  seededRandom,
} from "../../src/browser/human-pointer.js";

// Pure path and timing rules over many seeded draws: every bound holds for every seed.
const seeds = Array.from({ length: 400 }, (_, index) => index * 7919 + 1);
const moves = [
  { from: { x: 1919, y: 1079 }, to: { x: 400, y: 297 } },
  { from: { x: 10, y: 10 }, to: { x: 60, y: 14 } },
  { from: { x: 500, y: 500 }, to: { x: 500, y: 900 } },
  { from: { x: 800, y: 300 }, to: { x: 803, y: 301 } },
];

describe("humanPointerPath", () => {
  it("ends exactly on the target, within the time range, with points 12 to 20 ms apart on average", () => {
    for (const seed of seeds)
      for (const { from, to } of moves) {
        const path = humanPointerPath(from, to, seededRandom(seed));
        const last = path.at(-1);
        expect(last).toMatchObject(to);
        const durationMs = last?.atMs ?? 0;
        expect(durationMs).toBeGreaterThanOrEqual(pointerTiming.pathMs[0]);
        expect(durationMs).toBeLessThanOrEqual(pointerTiming.pathMs[1]);
        expect(durationMs / path.length).toBeGreaterThanOrEqual(pointerTiming.stepMs[0] - 1);
        expect(durationMs / path.length).toBeLessThanOrEqual(pointerTiming.stepMs[1] + 1);
        for (let index = 1; index < path.length; index++)
          expect(path[index]?.atMs).toBeGreaterThanOrEqual(path[index - 1]?.atMs ?? 0);
      }
  });

  it("never passes the target along the line and comes back, beyond its 1 px jitter", () => {
    for (const seed of seeds)
      for (const { from, to } of moves) {
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        const unit = { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
        let furthest = 0;
        for (const point of humanPointerPath(from, to, seededRandom(seed))) {
          const along = (point.x - from.x) * unit.x + (point.y - from.y) * unit.y;
          expect(along).toBeLessThanOrEqual(length + Math.SQRT2);
          // Progress only ever goes forward, but for jitter.
          expect(along).toBeGreaterThanOrEqual(furthest - 2 * Math.SQRT2);
          furthest = Math.max(furthest, along);
        }
      }
  });

  it("bows to one side by at most 15 % of the distance, and 80 px, plus jitter", () => {
    for (const seed of seeds)
      for (const { from, to } of moves) {
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        const normal = { x: -(to.y - from.y) / length, y: (to.x - from.x) / length };
        for (const point of humanPointerPath(from, to, seededRandom(seed))) {
          const aside = Math.abs((point.x - from.x) * normal.x + (point.y - from.y) * normal.y);
          expect(aside).toBeLessThanOrEqual(Math.min(80, length * 0.15) + Math.SQRT2);
        }
      }
  });

  it("is the target alone for a move under 2 px", () => {
    expect(humanPointerPath({ x: 5, y: 5 }, { x: 6, y: 6 }, seededRandom(1))).toEqual([
      { x: 6, y: 6, atMs: 0 },
    ]);
  });
});

describe("pointerTarget and clickTiming", () => {
  it("aims inside the middle half, never at the centre, and keeps pause and press in range", () => {
    for (const seed of seeds) {
      const random = seededRandom(seed);
      const { x, y } = pointerTarget(random);
      for (const fraction of [x, y]) {
        expect(Math.abs(fraction)).toBeGreaterThanOrEqual(0.05);
        expect(Math.abs(fraction)).toBeLessThanOrEqual(0.25);
      }
      const { pauseMs, pressMs } = clickTiming(random);
      expect(pauseMs).toBeGreaterThanOrEqual(pointerTiming.pauseMs[0]);
      expect(pauseMs).toBeLessThanOrEqual(pointerTiming.pauseMs[1]);
      expect(pressMs).toBeGreaterThanOrEqual(pointerTiming.pressMs[0]);
      expect(pressMs).toBeLessThanOrEqual(pointerTiming.pressMs[1]);
    }
  });

  it("skews the pause short: most pauses fall in the lower half of the range", () => {
    const random = seededRandom(42);
    const pauses = seeds.map(() => clickTiming(random).pauseMs);
    const middle = (pointerTiming.pauseMs[0] + pointerTiming.pauseMs[1]) / 2;
    expect(pauses.filter((pause) => pause < middle).length / pauses.length).toBeGreaterThan(0.6);
  });
});
