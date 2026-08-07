import { generateKeyPairSync, sign, type webcrypto } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_OIDC_JWKS_URL,
  GoogleOidcVerifierError,
  createGoogleOidcVerifier,
} from '../../../src/cli/google-oidc-verifier';

const claims = {
  iss: 'https://accounts.google.com',
  aud: 'https://hooks.clearworks.ai/relay/gmail-pubsub',
  exp: 2_000_000_000,
  iat: 1_999_999_500,
  email: 'signer@example.invalid',
  email_verified: true,
  ignored: 'must-not-be-returned',
};

function key(kid: string) {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
  };
}

function token(signingKey: ReturnType<typeof key>, overrides: { header?: Record<string, unknown>; claims?: Record<string, unknown> } = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: signingKey.kid, ...overrides.header })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...claims, ...overrides.claims })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), signingKey.privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}

function jwksResponse(keys: unknown[], options: { status?: number; contentType?: string; cacheControl?: string } = {}): Response {
  return new Response(JSON.stringify({ keys }), {
    status: options.status ?? 200,
    headers: {
      'content-type': options.contentType ?? 'application/json; charset=utf-8',
      'cache-control': options.cacheControl ?? 'public, max-age=600',
    },
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'GoogleOidcVerifierError', message: code, code });
}

describe('Google runtime OIDC verifier lane A', () => {
  it('verifies RS256 with the fixed JWKS request and returns only consumed claims', async () => {
    const signingKey = key('current');
    const fetchImpl = vi.fn(async () => jwksResponse([signingKey.jwk]));
    const verify = createGoogleOidcVerifier({ fetchImpl });

    await expect(verify(token(signingKey))).resolves.toEqual({
      iss: claims.iss,
      aud: claims.aud,
      exp: claims.exp,
      iat: claims.iat,
      email: claims.email,
      email_verified: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(GOOGLE_OIDC_JWKS_URL, expect.objectContaining({
      method: 'GET',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    ['too few segments', 'a.b'],
    ['too many segments', 'a.b.c.d'],
    ['empty segment', 'a..b'],
    ['padding', 'e30=.e30.c2ln'],
    ['non-url alphabet', 'e30.e30.a+b'],
  ])('rejects strict token encoding: %s', async (_name, jwt) => {
    const fetchImpl = vi.fn();
    await expectCode(createGoogleOidcVerifier({ fetchImpl })(jwt), 'google_oidc_invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['none', { alg: 'none' }],
    ['HMAC', { alg: 'HS256' }],
    ['EC', { alg: 'ES256' }],
    ['critical headers', { crit: ['b64'] }],
    ['missing kid', { kid: undefined }],
    ['empty kid', { kid: '' }],
    ['oversized kid', { kid: 'k'.repeat(257) }],
  ])('rejects algorithm/header confusion: %s', async (_name, header) => {
    const signingKey = key('original');
    const fetchImpl = vi.fn();
    await expectCode(createGoogleOidcVerifier({ fetchImpl })(token(signingKey, { header })), 'google_oidc_invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects altered header, payload, and signature', async () => {
    const signingKey = key('altered');
    const good = token(signingKey);
    const parts = good.split('.');
    const alteredHeader = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'altered', x: 1 })).toString('base64url')}.${parts[1]}.${parts[2]}`;
    const alteredPayload = `${parts[0]}.${Buffer.from(JSON.stringify({ ...claims, aud: 'altered' })).toString('base64url')}.${parts[2]}`;
    const signature = Buffer.from(parts[2]!, 'base64url');
    signature[0] ^= 1;
    const alteredSignature = `${parts[0]}.${parts[1]}.${signature.toString('base64url')}`;

    for (const jwt of [alteredHeader, alteredPayload, alteredSignature]) {
      const verify = createGoogleOidcVerifier({ fetchImpl: vi.fn(async () => jwksResponse([signingKey.jwk])) });
      await expectCode(verify(jwt), 'google_oidc_invalid');
    }
  });

  it.each([
    ['wrong type', (jwk: webcrypto.JsonWebKey) => ({ ...jwk, kty: 'EC' })],
    ['wrong use', (jwk: webcrypto.JsonWebKey) => ({ ...jwk, use: 'enc' })],
    ['wrong algorithm', (jwk: webcrypto.JsonWebKey) => ({ ...jwk, alg: 'HS256' })],
  ])('rejects an unusable matching JWK: %s', async (_name, mutate) => {
    const signingKey = key('unusable');
    const verify = createGoogleOidcVerifier({ fetchImpl: vi.fn(async () => jwksResponse([mutate(signingKey.jwk)])) });
    await expectCode(verify(token(signingKey)), 'google_oidc_invalid');
  });

  it('rejects duplicate keys, key-count overflow, and oversized responses', async () => {
    const signingKey = key('bounded');
    const cases = [
      jwksResponse([signingKey.jwk, signingKey.jwk]),
      jwksResponse(Array.from({ length: 33 }, (_, index) => ({ ...signingKey.jwk, kid: `key-${index}` }))),
      jwksResponse([{ ...signingKey.jwk, n: 'n'.repeat(16 * 1024 + 1) }]),
      new Response('x'.repeat(256 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
    ];
    for (const response of cases) {
      const verify = createGoogleOidcVerifier({ fetchImpl: vi.fn(async () => response) });
      await expectCode(verify(token(signingKey)), 'google_oidc_unavailable');
    }
  });

  it.each([
    ['status', () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })],
    ['content type', () => new Response('{}', { headers: { 'content-type': 'text/html' } })],
    ['schema', () => new Response('{"keys":"wrong"}', { headers: { 'content-type': 'application/json' } })],
    ['redirect', () => {
      const response = new Response('{"keys":[]}', { headers: { 'content-type': 'application/json' } });
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    }],
  ])('fails closed on cold-cache %s failure', async (_name, response) => {
    const signingKey = key('failure');
    await expectCode(createGoogleOidcVerifier({ fetchImpl: vi.fn(async () => response()) })(token(signingKey)), 'google_oidc_unavailable');
  });

  it('aborts timed-out requests and exposes only a stable unavailable code', async () => {
    const signingKey = key('timeout-secret-kid');
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error(`leak ${signingKey.kid}`)));
    }));
    const error = await createGoogleOidcVerifier({ fetchImpl: fetchImpl as typeof fetch, timeoutMs: 5 })(token(signingKey)).catch((caught) => caught);
    expect(error).toBeInstanceOf(GoogleOidcVerifierError);
    expect(String(error)).toBe('GoogleOidcVerifierError: google_oidc_unavailable');
    expect(JSON.stringify(error)).not.toContain(signingKey.kid);
  });

  it('uses fresh known keys, forces one refresh for an unknown kid, and rotates to the new key', async () => {
    const oldKey = key('old');
    const newKey = key('new');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jwksResponse([oldKey.jwk]))
      .mockResolvedValueOnce(jwksResponse([newKey.jwk]));
    const verify = createGoogleOidcVerifier({ fetchImpl });

    await expect(verify(token(oldKey))).resolves.toBeDefined();
    await expect(verify(token(oldKey))).resolves.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(verify(token(newKey))).resolves.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refreshes', async () => {
    const signingKey = key('shared');
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async () => pending);
    const verify = createGoogleOidcVerifier({ fetchImpl });
    const first = verify(token(signingKey));
    const second = verify(token(signingKey));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release(jwksResponse([signingKey.jwk]));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('preserves a fresh cache after malformed rotation refresh', async () => {
    const known = key('known');
    const unknown = key('unknown');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jwksResponse([known.jwk]))
      .mockResolvedValueOnce(jwksResponse([known.jwk, known.jwk]));
    const verify = createGoogleOidcVerifier({ fetchImpl });
    await verify(token(known));
    await expectCode(verify(token(unknown)), 'google_oidc_unavailable');
    await expect(verify(token(known))).resolves.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never accepts stale keys after cache expiry', async () => {
    const signingKey = key('expiring');
    let now = 0;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jwksResponse([signingKey.jwk], { cacheControl: 'max-age=1' }))
      .mockRejectedValueOnce(new Error('network detail must be redacted'));
    const verify = createGoogleOidcVerifier({ fetchImpl, now: () => now, minCacheMs: 10, maxCacheMs: 20 });
    await verify(token(signingKey));
    now = 21;
    await expectCode(verify(token(signingKey)), 'google_oidc_unavailable');
  });
});
