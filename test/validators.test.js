'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVideoUrl } = require('../server/validators');

test('aceita os formatos comuns de link do YouTube', () => {
  const cases = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
    'https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD123',
  ];
  for (const url of cases) {
    assert.equal(parseVideoUrl(url).id, 'dQw4w9WgXcQ', url);
  }
  assert.equal(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ').canonicalUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('rejeita links inválidos com códigos claros', () => {
  const expect = (url, code) => assert.throws(() => parseVideoUrl(url), (e) => e.code === code, url);
  expect('', 'URL_EMPTY');
  expect('   ', 'URL_EMPTY');
  expect('não é um link', 'URL_INVALID');
  expect('https://vimeo.com/123456', 'SOURCE_UNSUPPORTED');
  expect('https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ', 'SOURCE_UNSUPPORTED');
  expect('ftp://youtube.com/watch?v=dQw4w9WgXcQ', 'URL_INVALID');
  expect('https://www.youtube.com/playlist?list=PL123', 'PLAYLIST_UNSUPPORTED');
  expect('https://www.youtube.com/@canal', 'URL_INVALID');
  expect('https://www.youtube.com/watch?v=curto', 'URL_INVALID');
});
