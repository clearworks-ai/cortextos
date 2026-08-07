import { createPublicKey, verify as verifySignature, type KeyObject, type webcrypto } from 'crypto';
import type { GoogleOidcClaims, GoogleOidcVerifier } from './provider-shadow-ingress.js';

export const GOOGLE_OIDC_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

const MAX_JWT_BYTES = 8_192;
const MAX_ENCODED_HEADER_BYTES = 2_048;
const MAX_ENCODED_CLAIMS_BYTES = 12_000;
const MAX_DECODED_HEADER_BYTES = 1_536;
const MAX_DECODED_CLAIMS_BYTES = 8_192;
const MAX_SIGNATURE_BYTES = 1_024;
const MAX_KID_BYTES = 256;
const MAX_JWKS_BYTES = 256 * 1_024;
const MAX_JWKS_KEYS = 32;
const MAX_JWK_FIELD_BYTES = 16 * 1_024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_CACHE_MS = 5 * 60_000;
const MAX_CACHE_MS = 6 * 60 * 60_000;

type FetchLike = typeof fetch;

export interface GoogleOidcVerifierOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  minCacheMs?: number;
  maxCacheMs?: number;
}

export class GoogleOidcVerifierError extends Error {
  constructor(readonly code: 'google_oidc_invalid' | 'google_oidc_unavailable') {
    super(code);
    this.name = 'GoogleOidcVerifierError';
  }
}

interface ParsedToken {
  signingInput: string;
  signature: Buffer;
  kid: string;
  claims: GoogleOidcClaims;
}

interface CachedKeys {
  expiresAt: number;
  keys: Map<string, KeyObject>;
}

function invalid(): never {
  throw new GoogleOidcVerifierError('google_oidc_invalid');
}

function strictBase64Url(value: string, maxEncodedBytes: number, maxDecodedBytes: number): Buffer {
  if (
    value.length === 0
    || Buffer.byteLength(value) > maxEncodedBytes
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) invalid();

  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    invalid();
  }
  if (decoded.length === 0 || decoded.length > maxDecodedBytes || decoded.toString('base64url') !== value) invalid();
  return decoded;
}

function parseJsonObject(value: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString('utf8'));
  } catch {
    invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  return parsed as Record<string, unknown>;
}

function parseToken(jwt: string): ParsedToken {
  if (typeof jwt !== 'string' || Buffer.byteLength(jwt) > MAX_JWT_BYTES) invalid();
  const segments = jwt.split('.');
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) invalid();

  const encodedHeader = segments[0]!;
  const encodedClaims = segments[1]!;
  const encodedSignature = segments[2]!;
  const header = parseJsonObject(strictBase64Url(encodedHeader, MAX_ENCODED_HEADER_BYTES, MAX_DECODED_HEADER_BYTES));
  const claims = parseJsonObject(strictBase64Url(encodedClaims, MAX_ENCODED_CLAIMS_BYTES, MAX_DECODED_CLAIMS_BYTES));
  const signature = strictBase64Url(encodedSignature, MAX_JWT_BYTES, MAX_SIGNATURE_BYTES);

  if (header.alg !== 'RS256' || header.crit !== undefined) invalid();
  if (typeof header.kid !== 'string' || header.kid.length === 0 || Buffer.byteLength(header.kid) > MAX_KID_BYTES) invalid();

  return {
    signingInput: `${encodedHeader}.${encodedClaims}`,
    signature,
    kid: header.kid,
    claims: {
      iss: claims.iss,
      aud: claims.aud,
      exp: claims.exp,
      iat: claims.iat,
      email: claims.email,
      email_verified: claims.email_verified,
    },
  };
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) throw new GoogleOidcVerifierError('google_oidc_unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_JWKS_BYTES) {
        await reader.cancel();
        throw new GoogleOidcVerifierError('google_oidc_unavailable');
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof GoogleOidcVerifierError) throw error;
    throw new GoogleOidcVerifierError('google_oidc_unavailable');
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8');
}

function boundedJwk(value: unknown): value is webcrypto.JsonWebKey & { kid: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const fieldValue of Object.values(record)) {
    if (typeof fieldValue === 'string' && Buffer.byteLength(fieldValue) > MAX_JWK_FIELD_BYTES) return false;
  }
  return typeof record.kid === 'string'
    && record.kid.length > 0
    && Buffer.byteLength(record.kid) <= MAX_KID_BYTES
    && Object.values(record).every((fieldValue) => fieldValue === undefined || fieldValue === null || typeof fieldValue === 'string' || typeof fieldValue === 'boolean' || typeof fieldValue === 'number');
}

function usableSigningJwk(value: webcrypto.JsonWebKey): boolean {
  return value.kty === 'RSA'
    && value.alg === 'RS256'
    && value.use === 'sig'
    && typeof value.n === 'string'
    && value.n.length > 0
    && typeof value.e === 'string'
    && value.e.length > 0;
}

function parseJwks(body: string): Map<string, KeyObject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new GoogleOidcVerifierError('google_oidc_unavailable');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new GoogleOidcVerifierError('google_oidc_unavailable');
  const keys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_JWKS_KEYS) throw new GoogleOidcVerifierError('google_oidc_unavailable');

  const resolved = new Map<string, KeyObject>();
  const seen = new Set<string>();
  for (const candidate of keys) {
    if (!boundedJwk(candidate) || seen.has(candidate.kid)) throw new GoogleOidcVerifierError('google_oidc_unavailable');
    seen.add(candidate.kid);
    if (!usableSigningJwk(candidate)) continue;
    try {
      resolved.set(candidate.kid, createPublicKey({ key: candidate, format: 'jwk' }));
    } catch {
      throw new GoogleOidcVerifierError('google_oidc_unavailable');
    }
  }
  return resolved;
}

function cacheDuration(response: Response, minimum: number, maximum: number): number {
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)\s*(?:,|$)/i.exec(response.headers.get('cache-control') ?? '');
  const advertised = match ? Number(match[1]) * 1_000 : minimum;
  if (!Number.isSafeInteger(advertised)) return maximum;
  return Math.min(maximum, Math.max(minimum, advertised));
}

export function createGoogleOidcVerifier(options: GoogleOidcVerifierOptions = {}): GoogleOidcVerifier {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minCacheMs = options.minCacheMs ?? MIN_CACHE_MS;
  const maxCacheMs = options.maxCacheMs ?? MAX_CACHE_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(minCacheMs) || minCacheMs <= 0 || !Number.isFinite(maxCacheMs) || maxCacheMs < minCacheMs) {
    throw new GoogleOidcVerifierError('google_oidc_unavailable');
  }

  let cache: CachedKeys | undefined;
  let refreshPromise: Promise<CachedKeys> | undefined;

  const refresh = (): Promise<CachedKeys> => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(GOOGLE_OIDC_JWKS_URL, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok || response.redirected) throw new GoogleOidcVerifierError('google_oidc_unavailable');
        const contentType = response.headers.get('content-type') ?? '';
        if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new GoogleOidcVerifierError('google_oidc_unavailable');
        const body = await readBoundedResponse(response);
        const next: CachedKeys = {
          expiresAt: now() + cacheDuration(response, minCacheMs, maxCacheMs),
          keys: parseJwks(body),
        };
        cache = next;
        return next;
      } catch (error) {
        if (error instanceof GoogleOidcVerifierError) throw error;
        throw new GoogleOidcVerifierError('google_oidc_unavailable');
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      refreshPromise = undefined;
    });
    return refreshPromise;
  };

  return async (jwt: string): Promise<GoogleOidcClaims> => {
    const token = parseToken(jwt);
    const fresh = cache && cache.expiresAt > now() ? cache : undefined;
    let key = fresh?.keys.get(token.kid);

    if (!key) {
      const refreshed = await refresh();
      key = refreshed.keys.get(token.kid);
      if (!key) invalid();
    }

    let valid = false;
    try {
      valid = verifySignature('RSA-SHA256', Buffer.from(token.signingInput, 'ascii'), key, token.signature);
    } catch {
      invalid();
    }
    if (!valid) invalid();
    return token.claims;
  };
}
