#!/usr/bin/env node
'use strict';
// Simulador do yt-dlp para testes locais/offline. Usa o FFmpeg real para gerar a mídia.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const args = process.argv.slice(2);
const url = args[args.length - 1];
const id = /v=([\w-]{11})/.exec(url)?.[1] || 'dQw4w9WgXcQ';

const fail = (msg) => { process.stderr.write(`ERROR: [youtube] ${id}: ${msg}\n`); process.exit(1); };
if (id.startsWith('private')) fail('Private video. Sign in if you\'ve been granted access to this video');
if (id.startsWith('missing')) fail('Video unavailable');

const duration = 12;
const fmt = (o) => ({ format_note: `${o.height}p`, ...o });
const info = {
  id, title: 'Vídeo de demonstração: "Fluxo" / Teste', channel: 'Canal MediaFlow',
  channel_url: 'https://www.youtube.com/@mediaflow', duration, view_count: 1234567, upload_date: '20260912',
  webpage_url: `https://www.youtube.com/watch?v=${id}`, live_status: id.startsWith('livexx') ? 'is_live' : 'not_live',
  thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 480, height: 360 }],
  formats: [
    { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', abr: 129.5, filesize: 194000 },
    { format_id: '251', ext: 'webm', acodec: 'opus', vcodec: 'none', abr: 135, filesize: 200000 },
    fmt({ format_id: '134', ext: 'mp4', vcodec: 'avc1.4d401e', acodec: 'none', width: 640, height: 360, fps: 30, tbr: 600 }),
    fmt({ format_id: '135', ext: 'mp4', vcodec: 'avc1.4d401f', acodec: 'none', width: 854, height: 480, fps: 30, tbr: 1100 }),
    fmt({ format_id: '136', ext: 'mp4', vcodec: 'avc1.64001f', acodec: 'none', width: 1280, height: 720, fps: 30, tbr: 2200 }),
    ...(id.startsWith('lowres') ? [] : [fmt({ format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', width: 1920, height: 1080, fps: 60, tbr: 4400 })]),
    { format_id: 'sb0', ext: 'mhtml', format_note: 'storyboard', vcodec: 'none', acodec: 'none' },
  ],
};

if (args.includes('-J')) { process.stdout.write(JSON.stringify(info)); process.exit(0); }

const out = args[args.indexOf('-o') + 1];
const dir = path.dirname(out);
const isMp3 = args.includes('-x');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const files = isMp3 ? ['media.webm'] : ['media.f137.mp4', 'media.f140.m4a'];
  for (const f of files) {
    console.log(`[download] Destination: ${path.join(dir, f)}`);
    const total = 5_000_000;
    for (let i = 1; i <= 10; i++) {
      await sleep(120);
      console.log(`MFPROG|${(total * i) / 10}|${total}|NA|${2_400_000}|${Math.round((10 - i) * 0.12)}`);
    }
  }
  if (isMp3) {
    const kbps = args[args.indexOf('--audio-quality') + 1];
    console.log(`[ExtractAudio] Destination: ${path.join(dir, 'media.mp3')}`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`, '-b:a', kbps.replace('K', 'k'), path.join(dir, 'media.mp3')]);
  } else {
    const res = /res:(\d+)/.exec(args[args.indexOf('-S') + 1])[1];
    console.log(`[Merger] Merging formats into "${path.join(dir, 'media.mp4')}"`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${Math.round(res * 16 / 9 / 2) * 2}x${res}:rate=30:duration=${duration}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path.join(dir, 'media.mp4')]);
  }
  console.log(`[Metadata] Adding metadata to "${out}"`);
})();
