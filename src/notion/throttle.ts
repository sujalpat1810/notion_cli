export type RequestKind = "default" | "query";

export interface ThrottleOptions {
  /** Sustained requests per second across all calls. Notion allows 180/min (600/min on Business+). */
  ratePerSec?: number;
  burst?: number;
  /** Separate, stricter limit for data source / view queries and search (~3 req/s). */
  queryRatePerSec?: number;
  maxConcurrent?: number;
  /** After a 429, run at this fraction of the rate for `penaltyMs`. */
  penaltyFactor?: number;
  penaltyMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class TokenBucket {
  #tokens: number;
  #last: number;
  constructor(
    private readonly capacity: number,
    now: number,
  ) {
    this.#tokens = capacity;
    this.#last = now;
  }

  /** Milliseconds until a token is available at `rate` tokens/sec (0 = available now). */
  waitMs(now: number, rate: number): number {
    this.#refill(now, rate);
    return this.#tokens >= 1 ? 0 : Math.ceil(((1 - this.#tokens) / rate) * 1000);
  }

  take(now: number, rate: number): void {
    this.#refill(now, rate);
    this.#tokens -= 1;
  }

  #refill(now: number, rate: number): void {
    const elapsed = Math.max(0, now - this.#last) / 1000;
    this.#tokens = Math.min(this.capacity, this.#tokens + elapsed * rate);
    this.#last = now;
  }
}

/**
 * Process-wide request limiter: FIFO token buckets (global + queries), a global
 * pause honoured by every caller after a 429, an adaptive slow-down, and a
 * concurrency cap.
 */
export class Throttle {
  readonly #rate: number;
  readonly #queryRate: number;
  readonly #maxConcurrent: number;
  readonly #penaltyFactor: number;
  readonly #penaltyMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #global: TokenBucket;
  readonly #query: TokenBucket;

  #pausedUntil = 0;
  #penaltyUntil = 0;
  #chain: Promise<void> = Promise.resolve();
  #inFlight = 0;
  #slotWaiters: Array<() => void> = [];

  constructor(opts: ThrottleOptions = {}) {
    this.#rate = opts.ratePerSec ?? 2.7;
    this.#queryRate = opts.queryRatePerSec ?? 2.5;
    this.#maxConcurrent = opts.maxConcurrent ?? 3;
    this.#penaltyFactor = opts.penaltyFactor ?? 0.7;
    this.#penaltyMs = opts.penaltyMs ?? 60_000;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? defaultSleep;
    const burst = opts.burst ?? 3;
    this.#global = new TokenBucket(burst, this.#now());
    this.#query = new TokenBucket(1, this.#now());
  }

  /** Waits for a slot and a rate token. Call the returned function when the request finishes. */
  async acquire(kind: RequestKind = "default"): Promise<() => void> {
    await this.#takeSlot();
    const previous = this.#chain;
    let done!: () => void;
    this.#chain = new Promise<void>((r) => (done = r));
    try {
      await previous;
      for (;;) {
        const now = this.#now();
        const rate = this.#effectiveRate(now, this.#rate);
        const queryRate = this.#effectiveRate(now, this.#queryRate);
        const wait = Math.max(
          this.#pausedUntil - now,
          this.#global.waitMs(now, rate),
          kind === "query" ? this.#query.waitMs(now, queryRate) : 0,
        );
        if (wait <= 0) {
          this.#global.take(now, rate);
          if (kind === "query") this.#query.take(now, queryRate);
          break;
        }
        await this.#sleep(wait);
      }
    } catch (err) {
      this.#releaseSlot();
      throw err;
    } finally {
      done();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#releaseSlot();
    };
  }

  /** Blocks every caller until `ms` from now (used for Retry-After). */
  pauseFor(ms: number): void {
    this.#pausedUntil = Math.max(this.#pausedUntil, this.#now() + ms);
  }

  /** Slows the sustained rate for a while after a 429 (the budget is shared workspace-wide). */
  penalize(): void {
    this.#penaltyUntil = this.#now() + this.#penaltyMs;
  }

  #effectiveRate(now: number, rate: number): number {
    return now < this.#penaltyUntil ? rate * this.#penaltyFactor : rate;
  }

  async #takeSlot(): Promise<void> {
    if (this.#inFlight < this.#maxConcurrent) {
      this.#inFlight++;
      return;
    }
    await new Promise<void>((r) => this.#slotWaiters.push(r));
  }

  #releaseSlot(): void {
    const next = this.#slotWaiters.shift();
    if (next) next(); // hand the slot over directly
    else this.#inFlight--;
  }
}
