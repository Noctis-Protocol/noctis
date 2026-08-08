/**
 * Lightweight guards for /api/fhevm/* routes (Phase A harden).
 * - Origin allowlist (browser) OR optional shared API key
 * - Per-IP sliding-window rate limit
 * Dev defaults allow localhost so desk smoke keeps working.
 */
import { NextRequest, NextResponse } from "next/server";

type Bucket = { timestamps: number[] };

const buckets = new Map<string, Bucket>();

function allowedOrigins(): string[] {
  const raw =
    process.env.ALLOWED_ORIGINS ||
    "http://localhost:3000,http://127.0.0.1:3000";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const TRUST_PROXY =
  process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";

function clientIp(req: NextRequest): string {
  if (TRUST_PROXY) {
    const xf = req.headers.get("x-forwarded-for");
    if (xf) return xf.split(",")[0]?.trim() || "unknown";
    const realIp = req.headers.get("x-real-ip");
    if (realIp) return realIp;
  }
  return (req as { ip?: string }).ip ?? "unknown";
}

function prune(bucket: Bucket, windowMs: number, now: number) {
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
}

/** Returns null if OK, otherwise a NextResponse to return immediately. */
export function guardFhevmApi(
  req: NextRequest,
  opts: { route: string; limit: number; windowMs?: number }
): NextResponse | null {
  const windowMs = opts.windowMs ?? 60_000;
  const origin = req.headers.get("origin");
  const apiKey = req.headers.get("x-noctis-api-key");
  const expectedKey = process.env.FHEVM_API_KEY || "";

  // If API key is configured, accept matching key (server-to-server / curl)
  const keyOk = Boolean(expectedKey && apiKey && apiKey === expectedKey);

  if (!keyOk) {
    const allow = allowedOrigins();
    // Same-origin navigations / some browsers omit Origin on GET — allow missing Origin only for GET
    if (origin) {
      // Same-origin requests are always allowed, whatever domain alias serves
      // the app (apex, www, *.vercel.app). Otherwise adding a domain in Vercel
      // silently breaks the API with "Origin not allowed".
      let sameOrigin = false;
      try {
        const originHost = new URL(origin).host;
        const requestHost =
          req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
        sameOrigin = originHost.length > 0 && originHost === requestHost;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin && !allow.includes(origin)) {
        return NextResponse.json(
          { error: "Origin not allowed" },
          { status: 403 }
        );
      }
    } else if (req.method !== "GET") {
      // Require Origin or API key on mutating calls when no key configured
      if (expectedKey) {
        return NextResponse.json(
          { error: "Missing or invalid x-noctis-api-key" },
          { status: 401 }
        );
      }
      // Dev: allow missing Origin (same-origin fetch often sends Origin though)
    }
  }

  const ip = clientIp(req);
  const key = `${opts.route}:${ip}`;
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(key, bucket);
  }
  prune(bucket, windowMs, now);
  if (bucket.timestamps.length >= opts.limit) {
    return NextResponse.json(
      { error: "Rate limit exceeded", retryAfterSec: Math.ceil(windowMs / 1000) },
      { status: 429, headers: { "Retry-After": String(Math.ceil(windowMs / 1000)) } }
    );
  }
  bucket.timestamps.push(now);

  // Opportunistic cleanup of idle buckets
  if (buckets.size > 5_000) {
    for (const [k, b] of buckets) {
      prune(b, windowMs, now);
      if (b.timestamps.length === 0) buckets.delete(k);
    }
  }

  return null;
}
