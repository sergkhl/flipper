/** A shared limit, including work queued by independent comparison groups. */
export class WorkPool {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency must be a positive integer');
  }
  get running(): number { return this.active; }
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { signal?.throwIfAborted(); return await work(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}

/** Stop starting on failure, but drain every started operation before throwing. */
export async function concurrent<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>,
  options: { continue?: () => boolean; errorPriority?: (error: unknown) => number } = {}): Promise<R[]> {
  const results: R[] = []; let index = 0, failed = false, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && (options.continue?.() ?? true)) {
      const current = index++; if (current >= items.length) return;
      try { results[current] = await work(items[current]!, current); }
      catch (error) {
        if (!failed || (options.errorPriority?.(error) ?? 0) > (options.errorPriority?.(failure) ?? 0)) failure = error;
        failed = true;
      }
    }
  }));
  if (failed) throw failure;
  return results;
}

/** One writer per shared query prevents duplicate pages and lost checkpoints. */
export class KeyedWork {
  private pools = new Map<string, WorkPool>();
  run<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let pool = this.pools.get(key);
    if (!pool) { pool = new WorkPool(1); this.pools.set(key, pool); }
    return pool.run(work, signal);
  }
}
