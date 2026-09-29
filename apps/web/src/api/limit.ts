/** Runs at most `concurrency` tasks at once; the rest wait their turn. Reading many tables must not flood the lake. */
export function createLimiter(concurrency: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (running >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}
