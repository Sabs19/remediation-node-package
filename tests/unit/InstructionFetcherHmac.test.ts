import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

/**
 * Tests the async HMAC-SHA256 verification logic extracted from InstructionFetcher.
 *
 * We replicate the exact algorithm from verifyEnvelopeSignature() here so the
 * test runs without a Redis dependency, then cross-validate that a correctly
 * signed envelope passes and a tampered one fails.
 *
 * Uses Node.js globalThis.crypto.subtle (available from Node 18 onwards),
 * which is the same API InstructionFetcher uses in Edge and Node runtimes.
 */

const CLIENT_ID = 'TESTCLIENT1';
const TOKEN     = 'super-secret-test-token-for-fetch-test-99';

function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj !== null && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as object).sort()) {
      sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

function base64url(data: string): string {
  return Buffer.from(data).toString('base64url');
}

function buildSignedEnvelope(
  payload: Record<string, unknown>,
  token: string,
  mutateHmac?: (h: string) => string,
): Record<string, unknown> {
  const messageId = 'msg-' + Math.random().toString(36).slice(2);
  const nonce     = 'nonce-' + Math.random().toString(36).slice(2);
  const issuedAt  = Math.floor(Date.now() / 1000);

  const canonical = [
    '1.0', messageId, 'runtime_instruction', CLIENT_ID,
    String(issuedAt), nonce,
    base64url(JSON.stringify(sortKeysDeep(payload))),
  ].join('.');

  let hmac = createHmac('sha256', token).update(canonical).digest('hex');
  if (mutateHmac) hmac = mutateHmac(hmac);

  return {
    protocol_version: '1.0',
    message_id:       messageId,
    message_type:     'runtime_instruction',
    client_id:        CLIENT_ID,
    issued_at:        issuedAt,
    nonce,
    hmac_sha256:      hmac,
    payload,
  };
}

/**
 * Replicates InstructionFetcher.verifyEnvelopeSignature() using Web Crypto.
 * Returns true if the HMAC matches, false otherwise.
 */
async function verifyWithWebCrypto(
  envelope: Record<string, unknown>,
  token: string,
  clientId: string,
): Promise<boolean> {
  try {
    const hmacHex = String(envelope['hmac_sha256'] ?? '');
    if (
      envelope['client_id'] !== clientId ||
      typeof hmacHex !== 'string' ||
      hmacHex.length !== 64
    ) return false;

    const payload = (envelope['payload'] ?? {}) as Record<string, unknown>;
    const canonical = [
      String(envelope['protocol_version'] ?? ''),
      String(envelope['message_id']       ?? ''),
      String(envelope['message_type']     ?? ''),
      String(envelope['client_id']        ?? ''),
      String(envelope['issued_at']        ?? ''),
      String(envelope['nonce']            ?? ''),
      base64url(JSON.stringify(sortKeysDeep(payload))),
    ].join('.');

    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(token),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

    const sigBuffer = await globalThis.crypto.subtle.sign(
      'HMAC', key, new TextEncoder().encode(canonical),
    );

    const expectedHex = Array.from(new Uint8Array(sigBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const receivedHex = hmacHex.toLowerCase();
    if (expectedHex.length !== receivedHex.length) return false;

    let diff = 0;
    for (let i = 0; i < expectedHex.length; i++) {
      diff |= expectedHex.charCodeAt(i) ^ receivedHex.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('InstructionFetcher — async HMAC verification (Web Crypto)', () => {

  it('accepts a correctly signed envelope', async () => {
    const env = buildSignedEnvelope({ instruction_type: 'pii_mask' }, TOKEN);
    const ok  = await verifyWithWebCrypto(env, TOKEN, CLIENT_ID);
    assert.equal(ok, true);
  });

  it('rejects an envelope signed with a different token', async () => {
    const env = buildSignedEnvelope({ instruction_type: 'pii_mask' }, TOKEN);
    const ok  = await verifyWithWebCrypto(env, 'wrong-token', CLIENT_ID);
    assert.equal(ok, false);
  });

  it('rejects a tampered payload', async () => {
    const env = buildSignedEnvelope({ instruction_type: 'pii_mask' }, TOKEN);
    (env['payload'] as Record<string, unknown>)['instruction_type'] = 'route_block';
    const ok = await verifyWithWebCrypto(env, TOKEN, CLIENT_ID);
    assert.equal(ok, false);
  });

  it('rejects an all-zero HMAC', async () => {
    const env = buildSignedEnvelope({ x: 1 }, TOKEN, () => '0'.repeat(64));
    const ok  = await verifyWithWebCrypto(env, TOKEN, CLIENT_ID);
    assert.equal(ok, false);
  });

  it('rejects a near-miss HMAC differing by one character', async () => {
    const env = buildSignedEnvelope({ x: 1 }, TOKEN, (h) => {
      const last = h[63] === 'a' ? 'b' : 'a';
      return h.slice(0, 63) + last;
    });
    const ok = await verifyWithWebCrypto(env, TOKEN, CLIENT_ID);
    assert.equal(ok, false);
  });

  it('rejects a mismatched client_id', async () => {
    const env = buildSignedEnvelope({ x: 1 }, TOKEN);
    const ok  = await verifyWithWebCrypto(env, TOKEN, 'DIFFERENT_CLIENT');
    assert.equal(ok, false);
  });

  it('rejects an HMAC that is not 64 hex chars', async () => {
    const env = buildSignedEnvelope({ x: 1 }, TOKEN, (h) => h.slice(0, 32));
    const ok  = await verifyWithWebCrypto(env, TOKEN, CLIENT_ID);
    assert.equal(ok, false);
  });

  it('produces the same result as node:crypto for an identical canonical string', async () => {
    const payload   = { instruction_type: 'header_inject', priority: 10 };
    const env       = buildSignedEnvelope(payload, TOKEN);

    // node:crypto reference
    const nodeCryptoOk = (() => {
      const p = (env['payload'] ?? {}) as Record<string, unknown>;
      const c = [
        env['protocol_version'], env['message_id'], env['message_type'],
        env['client_id'], env['issued_at'], env['nonce'],
        base64url(JSON.stringify(sortKeysDeep(p))),
      ].join('.');
      const expected = createHmac('sha256', TOKEN).update(c).digest('hex');
      return expected === String(env['hmac_sha256']);
    })();

    // Web Crypto reference
    const webCryptoOk = await verifyWithWebCrypto(env, TOKEN, CLIENT_ID);

    assert.equal(nodeCryptoOk, true,   'node:crypto should validate');
    assert.equal(webCryptoOk,  true,   'Web Crypto should validate');
  });

});
