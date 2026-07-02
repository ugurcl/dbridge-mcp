export interface RateLimiter {
  take(): void;
}

export function createRateLimiter(perMinute: number): RateLimiter {
  if (perMinute <= 0) {
    return { take: () => undefined };
  }
  const hits: number[] = [];
  return {
    take() {
      const now = Date.now();
      const cutoff = now - 60000;
      while (hits.length > 0 && hits[0] < cutoff) {
        hits.shift();
      }
      if (hits.length >= perMinute) {
        throw new Error(`Rate limit exceeded: at most ${perMinute} queries per minute.`);
      }
      hits.push(now);
    },
  };
}
