import { NextFunction, Request, Response } from "express";

// Token bucket rate limiter: one bucket per client IP, starts full,
// refills at a fixed rate, each request consumes one token; empty bucket => 429.
const RATE_LIMIT_CAPACITY = Number(process.env.RATE_LIMIT_CAPACITY ?? 20);
const RATE_LIMIT_REFILL_PER_SEC = Number(process.env.RATE_LIMIT_REFILL_PER_SEC ?? 5);

interface TokenBucket {
  tokens: number;
  lastRefill: number; // ms since epoch
}

const buckets = new Map<string, TokenBucket>();

function getBucket(key: string): TokenBucket {
  const existing = buckets.get(key);
  if (existing) return existing;

  const fresh: TokenBucket = { tokens: RATE_LIMIT_CAPACITY, lastRefill: Date.now() };
  buckets.set(key, fresh);
  return fresh;
}

function refill(bucket: TokenBucket): void {
  const now = Date.now();
  const elapsedSec = (now - bucket.lastRefill) / 1000;
  const tokensToAdd = elapsedSec * RATE_LIMIT_REFILL_PER_SEC;

  if (tokensToAdd > 0) {
    bucket.tokens = Math.min(RATE_LIMIT_CAPACITY, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }
}

export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip ?? "unknown";
  const bucket = getBucket(key);

  refill(bucket);

  if (bucket.tokens < 1) {
    res.status(429).json({ error: "Too many requests. Please slow down." });
    return;
  }

  bucket.tokens -= 1;
  next();
}
