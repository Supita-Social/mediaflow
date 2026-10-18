'use strict';
// Teste de ponta a ponta da API usando o simulador do yt-dlp + FFmpeg real.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.YTDLP_PATH = path.join(__dirname, 'fixtures', 'fake-yt-dlp.js');
process.env.WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaflow-test-'));

const { app, jobs } = require('../server/index');

let server;
let base;
let cookie = '';

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return res;
}

async function waitFor(id) {
  for (let i = 0; i < 200; i++) {
    const { job } = await (await call('GET', `/api/jobs/${id}`)).json();
    if (['done', 'error', 'canceled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
}

test.before(async () => {
  await jobs.init();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); clearInterval(jobs.cleanupTimer); });

const URL_OK = 'https://youtu.be/dQw4w9WgXcQ';

test('analisa um vídeo e retorna as opções disponíveis', async () => {
  const res = await call('POST', '/api/analyze', { url: URL_OK });
  assert.equal(res.status, 200);
  const { video } = await res.json();
  assert.equal(video.id, 'dQw4w9WgXcQ');
  assert.deepEqual(video.formats.mp4.map((o) => o.quality), [360, 480, 720, 1080]);
  assert.deepEqual(video.formats.mp3.map((o) => o.bitrate), [128, 192]);
  assert.ok(video.formats.mp4[3].estimatedBytes > 0);
});

test('oculta 1080p quando a fonte não oferece', async () => {
  const { video } = await (await call('POST', '/api/analyze', { url: 'https://youtu.be/lowresxxxxx' })).json();
  assert.deepEqual(video.formats.mp4.map((o) => o.quality), [360, 480, 720]);
});

test('traduz erros da fonte', async () => {
  const res = await call('POST', '/api/analyze', { url: 'https://youtu.be/privatexxxx' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'VIDEO_PRIVATE');
  const res2 = await call('POST', '/api/analyze', { url: 'https://youtu.be/missingxxxx' });
  assert.equal((await res2.json()).error.code, 'VIDEO_UNAVAILABLE');
  const res3 = await call('POST', '/api/analyze', { url: 'https://vimeo.com/1' });
  assert.equal((await res3.json()).error.code, 'SOURCE_UNSUPPORTED');
});

test('exige confirmação de autorização e qualidade válida', async () => {
  let res = await call('POST', '/api/convert', { url: URL_OK, format: 'mp3', quality: 192 });
  assert.equal((await res.json()).error.code, 'AUTHORIZATION_REQUIRED');
  res = await call('POST', '/api/convert', { url: URL_OK, format: 'mp3', quality: 320, authorized: true });
  assert.equal((await res.json()).error.code, 'QUALITY_UNAVAILABLE');
  res = await call('POST', '/api/convert', { url: 'https://youtu.be/lowresxxxxx', format: 'mp4', quality: 1080, authorized: true });
  assert.equal((await res.json()).error.code, 'QUALITY_UNAVAILABLE');
});

test('converte para MP3 e entrega o arquivo', async () => {
  const res = await call('POST', '/api/convert', { url: URL_OK, format: 'mp3', quality: 192, authorized: true });
  assert.equal(res.status, 202);
  const { job } = await res.json();
  const done = await waitFor(job.id);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal(done.file.name, 'Vídeo de demonstração Fluxo Teste.mp3');
  const file = await call('GET', done.file.url);
  assert.equal(file.headers.get('content-type'), 'audio/mpeg');
  assert.match(file.headers.get('content-disposition'), /filename\*=UTF-8''V%C3%ADdeo/);
  const buf = Buffer.from(await file.arrayBuffer());
  assert.equal(buf.length, done.file.size);
  assert.ok(buf.subarray(0, 3).toString() === 'ID3' || buf[0] === 0xff);
});

test('converte para MP4 1080p com progresso via SSE', async () => {
  const { job } = await (await call('POST', '/api/convert', { url: URL_OK, format: 'mp4', quality: 1080, authorized: true })).json();
  const res = await fetch(`${base}/api/jobs/${job.id}/events`, { headers: { cookie } });
  const text = await res.text();
  const events = text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  const statuses = new Set(events.map((e) => e.status));
  assert.ok(statuses.has('downloading') && statuses.has('processing') && statuses.has('done'), [...statuses].join());
  const percents = events.map((e) => e.percent);
  assert.deepEqual(percents, [...percents].sort((a, b) => a - b), 'progresso nunca retrocede');
  const last = events.at(-1);
  assert.equal(last.file.name.endsWith('.mp4'), true);
});

test('permite cancelar uma conversão em andamento', async () => {
  const { job } = await (await call('POST', '/api/convert', { url: URL_OK, format: 'mp4', quality: 720, authorized: true })).json();
  await new Promise((r) => setTimeout(r, 400));
  await call('DELETE', `/api/jobs/${job.id}`);
  const final = await waitFor(job.id);
  assert.equal(final.status, 'canceled');
});

test('não expõe conversões de outros usuários', async () => {
  const { job } = await (await call('POST', '/api/convert', { url: URL_OK, format: 'mp3', quality: 128, authorized: true })).json();
  const res = await fetch(`${base}/api/jobs/${job.id}`);
  assert.equal(res.status, 404);
  await waitFor(job.id);
});
