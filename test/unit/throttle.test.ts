import { describe, expect, it } from "vitest";
import { Throttle } from "../../src/notion/throttle";

/** Deterministic clock: sleeping advances virtual time instantly. */
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    get time() {
      return t;
    },
  };
}

describe("Throttle", () => {
  it("allows the burst immediately, then spaces requests at the sustained rate", async () => {
    const clock = virtualClock();
    const throttle = new Throttle({ ratePerSec: 2, burst: 3, maxConcurrent: 100, now: clock.now, sleep: clock.sleep });
    const startTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const release = await throttle.acquire();
      startTimes.push(clock.time);
      release();
    }
    expect(startTimes.slice(0, 3)).toEqual([0, 0, 0]);
    expect(startTimes[3]).toBe(500);
    expect(startTimes[4]).toBe(1000);
  });

  it("applies the stricter query bucket only to queries", async () => {
    const clock = virtualClock();
    const throttle = new Throttle({ ratePerSec: 100, burst: 100, queryRatePerSec: 1, maxConcurrent: 100, now: clock.now, sleep: clock.sleep });
    (await throttle.acquire("query"))();
    (await throttle.acquire("default"))();
    expect(clock.time).toBe(0);
    (await throttle.acquire("query"))();
    expect(clock.time).toBe(1000);
  });

  it("pauses every caller after pauseFor (Retry-After)", async () => {
    const clock = virtualClock();
    const throttle = new Throttle({ ratePerSec: 100, burst: 100, maxConcurrent: 100, now: clock.now, sleep: clock.sleep });
    throttle.pauseFor(3000);
    (await throttle.acquire())();
    expect(clock.time).toBe(3000);
  });

  it("slows down after penalize()", async () => {
    const clock = virtualClock();
    const throttle = new Throttle({ ratePerSec: 1, burst: 1, penaltyFactor: 0.5, maxConcurrent: 100, now: clock.now, sleep: clock.sleep });
    (await throttle.acquire())();
    throttle.penalize();
    (await throttle.acquire())();
    expect(clock.time).toBe(2000); // 0.5 req/s while penalized
  });

  it("caps concurrency and hands slots over on release", async () => {
    const clock = virtualClock();
    const throttle = new Throttle({ ratePerSec: 1000, burst: 1000, maxConcurrent: 2, now: clock.now, sleep: clock.sleep });
    const r1 = await throttle.acquire();
    const r2 = await throttle.acquire();
    let thirdStarted = false;
    const third = throttle.acquire().then((r) => {
      thirdStarted = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(thirdStarted).toBe(false);
    r1();
    (await third)();
    expect(thirdStarted).toBe(true);
    r2();
  });
});
