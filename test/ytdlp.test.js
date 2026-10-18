'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeInfo, buildDownloadArgs, qualityLabel } = require('../server/ytdlp');

const base = (formats, extra = {}) => ({ id: 'abcdefghijk', title: 'T', duration: 100, formats, ...extra });
const v = (height, width, extra = {}) => ({ vcodec: 'avc1.64', acodec: 'none', height, width, tbr: height * 2, ...extra });

test('mostra apenas resoluções disponíveis na fonte', () => {
  const s = summarizeInfo(base([v(360, 640), v(720, 1280), { acodec: 'opus', vcodec: 'none', abr: 130 }]));
  assert.deepEqual(s.formats.mp4.map((o) => o.quality), [360, 720]);
  assert.equal(s.maxVideoQuality, 720);
});

test('vídeos verticais usam o menor lado como resolução', () => {
  assert.equal(qualityLabel({ height: 1920, width: 1080 }), 1080);
  assert.equal(qualityLabel({ height: 536, width: 1280, format_note: '720p' }), 720);
  assert.equal(qualityLabel({ height: 536, width: 1280 }), 720);
});

test('limita taxas de MP3 ao que a fonte sustenta', () => {
  const opus = summarizeInfo(base([{ acodec: 'opus', vcodec: 'none', abr: 160 }]));
  assert.deepEqual(opus.formats.mp3.map((o) => o.bitrate), [128, 192]);
  const lowAac = summarizeInfo(base([{ acodec: 'mp4a.40.5', vcodec: 'none', abr: 48 }]));
  assert.deepEqual(lowAac.formats.mp3.map((o) => o.bitrate), [128]);
  const flac = summarizeInfo(base([{ acodec: 'flac', vcodec: 'none', abr: 900 }]));
  assert.deepEqual(flac.formats.mp3.map((o) => o.bitrate), [128, 192, 256, 320]);
  assert.equal(opus.formats.mp4.length, 0);
});

test('rejeita transmissões ao vivo e vídeos longos demais', () => {
  assert.throws(() => summarizeInfo(base([], { is_live: true })), { code: 'LIVE_UNSUPPORTED' });
  assert.throws(() => summarizeInfo(base([], { duration: 99999 })), { code: 'VIDEO_TOO_LONG' });
});

test('monta argumentos corretos para MP3 e MP4', () => {
  const mp3 = buildDownloadArgs({ url: 'https://www.youtube.com/watch?v=abcdefghijk', format: 'mp3', quality: 192, outputTemplate: '/t/m.%(ext)s' });
  assert.ok(mp3.includes('--audio-format') && mp3.includes('192K'));
  assert.equal(mp3.at(-2), '--');
  const mp4 = buildDownloadArgs({ url: 'https://www.youtube.com/watch?v=abcdefghijk', format: 'mp4', quality: 1080, outputTemplate: '/t/m.%(ext)s' });
  assert.ok(mp4.some((a) => a.startsWith('res:1080')));
  assert.ok(mp4.includes('--merge-output-format'));
});
