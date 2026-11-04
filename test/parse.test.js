// 解析器單元測試：node --test test/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import discuz from '../src/adapters/discuz.js';
import generic from '../src/adapters/generic.js';
import rules from '../src/adapters/rules.js';
import telegram from '../src/adapters/telegram.js';
import { classify } from '../src/links.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const doc = (html) => parseHTML(html).document;

test('classify', () => {
  assert.equal(classify('https://pan.quark.cn/s/abc123'), 'quark');
  assert.equal(classify('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'), 'magnet');
  assert.equal(classify('https://pan.baidu.com/s/1xyz?pwd=ab12'), 'baidu');
  assert.equal(classify('https://example.com/a.torrent'), 'torrent');
  assert.equal(classify('https://example.com/page'), 'other');
  assert.equal(classify('javascript:alert(1)'), null);
});

test('telegram normalize', () => {
  assert.equal(telegram.normalize(new URL('https://t.me/Some_Channel')).toString(), 'https://t.me/s/Some_Channel');
  assert.equal(telegram.normalize(new URL('https://t.me/s/Some_Channel?before=100')).toString(), 'https://t.me/s/Some_Channel?before=100');
  assert.equal(telegram.normalize(new URL('https://t.me/Some_Channel/500')).toString(), 'https://t.me/s/Some_Channel?before=501');
  assert.throws(() => telegram.normalize(new URL('https://t.me/')));
  assert.equal(telegram.sourceKey(new URL('https://t.me/s/Some_Channel')), 'tg:some_channel');
});

test('telegram parse', () => {
  const url = new URL('https://t.me/s/Demo_Channel');
  const r = telegram.parse(doc(fixture('telegram.html')), url);
  assert.equal(r.title, '示範頻道');
  assert.equal(r.next, 'https://t.me/s/Demo_Channel?before=101');
  assert.equal(r.items.length, 2); // 沒有連結的貼文略過
  const [b, a] = r.items; // 新的在前
  assert.equal(b.key, 'Demo_Channel/103');
  assert.equal(b.title, '範例影片 B（2026）');
  assert.equal(b.size, null); // 「大小：X」視為未知
  assert.deepEqual(b.links.map((l) => l.type).sort(), ['baidu', 'magnet']);
  assert.equal(b.links.find((l) => l.type === 'baidu').code, 'ab12');
  assert.equal(a.title, '範例影片 A（2026）4K');
  assert.equal(a.size, '12GB');
  assert.deepEqual(a.tags, ['动画', '剧情']);
  assert.equal(a.links.length, 1);
  assert.equal(a.links[0].type, 'quark');
  assert.equal(a.date, '2026-11-01T10:00:00+00:00');
});

test('discuz forum list', () => {
  const url = new URL('https://www.example-forum.com/forum.php?mod=forumdisplay&fid=12');
  const r = discuz.parse(doc(fixture('discuz-list.html')), url);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].title, '[置頂] 版規');
  assert.deepEqual(r.items[0].tags, ['置頂']);
  assert.equal(r.items[1].key, 'tid:5002');
  assert.equal(r.items[1].links[0].type, 'thread');
  assert.equal(r.items[1].links[0].url, 'https://www.example-forum.com/forum.php?mod=viewthread&tid=5002');
  assert.equal(r.next, 'https://www.example-forum.com/forum.php?mod=forumdisplay&fid=12&page=2');
  assert.equal(discuz.sourceKey(url), 'dz:www.example-forum.com:f12');
});

test('discuz thread', () => {
  const url = new URL('https://www.example-forum.com/forum.php?mod=viewthread&tid=5002');
  const r = discuz.parse(doc(fixture('discuz-thread.html')), url);
  assert.equal(r.title, '範例動畫 第01-12話');
  const byKey = Object.fromEntries(r.items.map((i) => [i.key, i]));
  assert.ok(byKey['aid:777'], 'torrent 附件');
  assert.equal(byKey['aid:777'].title, 'demo_01-12.torrent');
  assert.equal(byKey['aid:777'].size, '23.5 KB');
  assert.equal(byKey['aid:777'].links[0].type, 'torrent');
  const mag = byKey['btih:0123456789abcdef0123456789abcdef01234567'];
  assert.ok(mag, 'magnet');
  assert.equal(mag.title, 'Demo 01-12');
  assert.ok(!r.items.some((i) => i.key.startsWith('aid:778')), '圖片附件不列');
  assert.equal(discuz.sourceKey(url), 'dz:www.example-forum.com:t5002');
});

test('generic', () => {
  const html = `<html><head><title>測試頁</title></head><body>
    <p>檔案 <a href="/files/a.torrent">a.torrent</a></p>
    <p>magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&amp;dn=Hello</p>
    <p><a href="https://example.com/about">關於</a></p>
    <p>ed2k://|file|test.mkv|1048576|0123456789ABCDEF0123456789ABCDEF|/</p></body></html>`;
  const r = generic.parse(doc(html), new URL('https://site.example/page'));
  assert.equal(r.items.length, 3);
  const types = r.items.map((i) => i.links[0].type).sort();
  assert.deepEqual(types, ['ed2k', 'magnet', 'torrent']);
  assert.equal(r.items.find((i) => i.links[0].type === 'magnet').title, 'Hello');
  assert.equal(r.items.find((i) => i.links[0].type === 'ed2k').size, '1.0 MB');
});

test('rules', () => {
  const html = `<div class="post"><h2><a href="/p/1">第一篇</a></h2><span class="sz">700MB</span>
      <a class="dl" href="https://pan.quark.cn/s/aaa">下載</a><a href="/other">其他</a></div>
    <div class="post"><h2><a href="/p/2">第二篇</a></h2><a class="dl" href="https://pan.quark.cn/s/bbb">下載</a></div>
    <div class="post"><h2>沒有連結</h2></div><a class="next" href="/page/2">下一頁</a>`;
  const r = rules.parse(doc(html), new URL('https://blog.example/'), {
    rules: { item: '.post', title: 'h2', link: 'a.dl', size: '.sz', next: 'a.next' },
  });
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].title, '第一篇');
  assert.equal(r.items[0].size, '700MB');
  assert.equal(r.items[0].links.length, 1);
  assert.equal(r.items[0].links[0].url, 'https://pan.quark.cn/s/aaa');
  assert.equal(r.next, 'https://blog.example/page/2');
  assert.throws(() => rules.parse(doc(html), new URL('https://blog.example/'), { rules: {} }));
});
