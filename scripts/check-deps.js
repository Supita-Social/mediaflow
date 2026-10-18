'use strict';
// Verifica se yt-dlp e FFmpeg estão instalados e acessíveis.
const { execFileSync } = require('node:child_process');
const config = require('../server/config');

const checks = [
  ['yt-dlp', config.ytdlpPath, ['--version']],
  ['FFmpeg', config.ffmpegPath ? `${config.ffmpegPath.replace(/\/$/, '')}/ffmpeg` : 'ffmpeg', ['-version']],
];

let ok = true;
for (const [name, bin, args] of checks) {
  try {
    const out = execFileSync(bin, args, { encoding: 'utf8' }).split('\n')[0];
    console.log(`✔ ${name}: ${out}`);
  } catch {
    ok = false;
    console.error(`✖ ${name} não encontrado (${bin}). Consulte o README para instalar.`);
  }
}
process.exit(ok ? 0 : 1);
