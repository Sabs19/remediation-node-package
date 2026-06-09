import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SignatureError } from '../../src/exceptions/SignatureError.js';

/**
 * Tests the HMAC-SHA256 canonical-string construction and constant-time comparison
 * that AgentConnectionService relies on — tested here without a Redis dependency.
 */

const CLIENT_ID = 'TESTCLIENT1';
const RAW_TOKEN = 'super-secret-test-token-for-unit-test-42';

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

function buildEnvelope(
  payload: Record<string, unknown>,
  token: string,
  overrideHmac?: string,
): Record<string, unknown> {
  const messageId = 'test-msg-id-' + Math.random().toString(36).slice(2);
  const nonce     = 'test-nonce-' + Math.random().toString(36).slice(2);
  const issuedAt  = Math.floor(Date.now() / 1000);

  const canonical = [
    '1.0', messageId, 'runtime_instruction', CLIENT_ID,
    String(issuedAt), nonce,
    base64url(JSON.stringify(sortKeysDeep(payload))),
  ].join('.');

  const hmac = overrideHmac ?? createHmac('sha256', token).update(canonical).digest('hex');

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

function verifyHmac(raw: Record<string, unknown>, token: string): void {
  const canonical = [
    String(raw['protocol_version']),
    String(raw['message_id']),
    String(raw['message_type']),
    String(raw['client_id']),
    String(raw['issued_at']),
    String(raw['nonce']),
    base64url(JSON.stringify(sortKeysDeep(raw['payload'] as Record<string, unknown>))),
  ].join('.');

  const expected = createHmac('sha256', token).update(canonical).digest('hex');
  const received = String(raw['hmac_sha256'] ?? '').toLowerCase();

  if (expected.length !== received.length) throw new SignatureError('HMAC length mismatch.');

  const bufA = Buffer.from(expected);
  const bufB = Buffer.from(received);
  if (!timingSafeEqual(bufA, bufB)) throw new SignatureError('HMAC verification failed.');
}

// -------------------------------------------------------------------------

describe('HMAC verification', () => {

  it('accepts a correctly signed envelope', () => {
    const env = buildEnvelope({ instruction_type: 'pii_mask' }, RAW_TOKEN);
    assert.doesNotThrow(() => verifyHmac(env, RAW_TOKEN));
  });

  it('rejects an envelope signed with the wrong token', () => {
    const env = buildEnvelope({ instruction_type: 'pii_mask' }, RAW_TOKEN);
    assert.throws(() => verifyHmac(env, 'wrong-token'), SignatureError);
  });

  it('rejects a tampered payload field', () => {
    const env = buildEnvelope({ instruction_type: 'pii_mask' }, RAW_TOKEN);
    (env['payload'] as Record<string, unknown>)['instruction_type'] = 'route_block';
    assert.throws(() => verifyHmac(env, RAW_TOKEN), SignatureError);
  });

  it('rejects a forged all-zero HMAC', () => {
    const env = buildEnvelope({ key: 'val' }, RAW_TOKEN, '0'.repeat(64));
    assert.throws(() => verifyHmac(env, RAW_TOKEN), SignatureError);
  });

  it('rejects a near-miss HMAC differing by one character', () => {
    const env    = buildEnvelope({ key: 'val' }, RAW_TOKEN);
    const hmac   = String(env['hmac_sha256']);
    const last   = hmac[63] === 'a' ? 'b' : 'a';
    env['hmac_sha256'] = hmac.slice(0, 63) + last;
    assert.throws(() => verifyHmac(env, RAW_TOKEN), SignatureError);
  });

  it('is invariant to payload key insertion order', () => {
    const ascending  = { a: 1, b: 2, c: 3 };
    const descending = { c: 3, b: 2, a: 1 };

    assert.equal(
      JSON.stringify(sortKeysDeep(ascending)),
      JSON.stringify(sortKeysDeep(descending)),
    );
  });

  it('nonce is unique across two envelope builds', () => {
    const a = buildEnvelope({ x: 1 }, RAW_TOKEN);
    const b = buildEnvelope({ x: 1 }, RAW_TOKEN);
    assert.notEqual(a['nonce'], b['nonce']);
  });

});
