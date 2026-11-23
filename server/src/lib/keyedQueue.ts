const tails = new Map<string, Promise<void>>();

/**
 * Runs `fn` after every earlier call with the same key has finished, one at a time per key.
 * Waiting costs nothing (no database connection is held), so a crowd of requests for the same
 * slot does not pile up on the connection pool. This only reorders work inside one process: the
 * database lock and the exclusion constraint still decide who wins across processes.
 */
export async function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  tails.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
