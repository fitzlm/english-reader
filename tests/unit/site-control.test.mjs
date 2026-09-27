import assert from 'node:assert/strict';
import { test } from 'node:test';

// 站点开关的纯函数：origin 校验、页面地址判定、来源闸门、匹配模式、待开启意图过期。
import {
  PENDING_TTL,
  isExtensionPageSender,
  isPendingFresh,
  isValidOrigin,
  patternCoversOrigin,
  patternOf,
  siteOfUrl,
} from '../../src/shared/site-control.js';

test('只接受规范的 http(s) origin', () => {
  assert.equal(isValidOrigin('https://example.com'), true);
  assert.equal(isValidOrigin('http://127.0.0.1:1234'), true);
  for (const bad of [
    'https://example.com/',
    'https://example.com/path',
    'https://Example.com',
    'https://example.com:443',
    'ftp://example.com',
    'chrome://extensions',
    'file:///tmp',
    'example.com',
    '',
    null,
    42,
  ]) {
    assert.equal(isValidOrigin(bad), false, String(bad));
  }
});

test('匹配模式带端口原样拼接', () => {
  assert.equal(patternOf('https://example.com'), 'https://example.com/*');
  assert.equal(patternOf('http://127.0.0.1:1234'), 'http://127.0.0.1:1234/*');
});

test('页面地址：http(s) 普通网页可开启，内置页、扩展页、应用商店、看不到地址不行', () => {
  assert.deepEqual(siteOfUrl('https://news.example.com/a?b#c'), { origin: 'https://news.example.com', host: 'news.example.com' });
  assert.deepEqual(siteOfUrl('http://127.0.0.1:8080/x'), { origin: 'http://127.0.0.1:8080', host: '127.0.0.1' });
  for (const url of [
    'chrome://settings',
    'chrome-extension://abc/src/options/options.html',
    'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore/detail/x',
    'file:///Users/a.html',
    'about:blank',
    '',
    undefined,
  ]) {
    assert.equal(siteOfUrl(url), null, String(url));
  }
});

test('来源闸门只放行本扩展自己的页面', () => {
  const base = 'chrome-extension://me/';
  assert.equal(isExtensionPageSender({ id: 'me', url: `${base}src/popup/popup.html` }, 'me', base), true);
  assert.equal(isExtensionPageSender({ id: 'me', url: `${base}src/popup/popup.html?tabId=3`, tab: { id: 3 } }, 'me', base), true);
  // 内容脚本：id 相同但 url 是网页
  assert.equal(isExtensionPageSender({ id: 'me', url: 'https://example.com/', tab: { id: 1 }, frameId: 0 }, 'me', base), false);
  assert.equal(isExtensionPageSender({ id: 'other', url: 'chrome-extension://other/x.html' }, 'me', base), false);
  assert.equal(isExtensionPageSender({ id: 'other', url: `${base}x.html` }, 'me', base), false);
  assert.equal(isExtensionPageSender({ id: 'me' }, 'me', base), false);
  assert.equal(isExtensionPageSender(null, 'me', base), false);
});

test('权限事件的匹配模式覆盖判断', () => {
  const origin = 'http://127.0.0.1:1234';
  assert.equal(patternCoversOrigin('http://127.0.0.1:1234/*', origin), true);
  assert.equal(patternCoversOrigin('http://127.0.0.1/*', origin), true);
  assert.equal(patternCoversOrigin('*://127.0.0.1/*', origin), true);
  assert.equal(patternCoversOrigin('http://127.0.0.1:9999/*', origin), false);
  assert.equal(patternCoversOrigin('https://127.0.0.1/*', origin), false);
  assert.equal(patternCoversOrigin('https://example.com/*', 'https://example.com'), true);
  assert.equal(patternCoversOrigin('https://*.example.com/*', 'https://www.example.com'), true);
  assert.equal(patternCoversOrigin('https://*.example.com/*', 'https://evil-example.com'), false);
  assert.equal(patternCoversOrigin('https://example.com/*', 'https://www.example.com'), false);
  assert.equal(patternCoversOrigin('<all_urls>', 'https://a.com'), true);
  assert.equal(patternCoversOrigin('garbage', 'https://a.com'), false);
});

test('待开启意图两分钟后过期', () => {
  const now = 1_000_000;
  assert.equal(isPendingFresh({ at: now }, now), true);
  assert.equal(isPendingFresh({ at: now - PENDING_TTL + 1 }, now), true);
  assert.equal(isPendingFresh({ at: now - PENDING_TTL }, now), false);
  assert.equal(isPendingFresh({ at: now + 5000 }, now), false);
  assert.equal(isPendingFresh(null, now), false);
  assert.equal(isPendingFresh({}, now), false);
});
