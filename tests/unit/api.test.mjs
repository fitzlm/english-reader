import assert from 'node:assert/strict';
import { test } from 'node:test';

// api.js 顶层只引用 chrome.*，在函数里才用到；这里只测纯函数
globalThis.chrome = { storage: { local: {} } };
const { tokenExpiry } = await import('../../src/shared/api.js');

function jwt(payload) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.signature`;
}

test('从 JWT 里读出过期时间', () => {
  assert.equal(tokenExpiry(jwt({ sub: 'u', exp: 1790000000 })), 1790000000 * 1000);
  // base64url 的 - 与 _ 以及缺省的 = 填充都能处理
  assert.equal(tokenExpiry(jwt({ sub: 'ü?>>', role: 'guest', exp: 1790000001 })), 1790000001 * 1000);
});

test('解不出来就返回 0（按不知道处理）', () => {
  assert.equal(tokenExpiry('not-a-jwt'), 0);
  assert.equal(tokenExpiry(jwt({ sub: 'u' })), 0);
  assert.equal(tokenExpiry(''), 0);
});
