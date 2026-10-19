'use strict';

const path = require('node:path');
const fs = require('node:fs');

// Carrega um arquivo .env simples (CHAVE=valor), sem dependências externas.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, raw] = match;
    if (process.env[key] === undefined) {
      process.env[key] = raw.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const int = (name, fallback) => {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) ? value : fallback;
};

const float = (name, fallback) => {
  const value = Number.parseFloat(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

module.exports = Object.freeze({
  port: int('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  trustProxy: process.env.TRUST_PROXY === 'true',

  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath: process.env.FFMPEG_PATH || '',
  // Arquivo de cookies (formato Netscape) opcional, útil em servidores que o YouTube limita.
  cookiesFile: process.env.YTDLP_COOKIES_FILE || '',
  // Runtime JavaScript usado pelo yt-dlp para resolver os desafios do YouTube.
  // O Node.js já está disponível; use "deno" se preferir, ou deixe vazio para o padrão do yt-dlp.
  jsRuntimes: process.env.YTDLP_JS_RUNTIMES ?? 'node',

  workDir: path.resolve(process.env.WORK_DIR || path.join(__dirname, '..', 'tmp')),

  maxConcurrentJobs: int('MAX_CONCURRENT_JOBS', 2),
  maxQueueSize: int('MAX_QUEUE_SIZE', 20),
  maxDurationSeconds: int('MAX_DURATION_SECONDS', 3 * 60 * 60),
  maxFileSizeMb: int('MAX_FILESIZE_MB', 2048),
  fileTtlMinutes: int('FILE_TTL_MINUTES', 30),
  analyzeTimeoutMs: int('ANALYZE_TIMEOUT_MS', 45_000),
  jobTimeoutMs: int('JOB_TIMEOUT_MS', 30 * 60_000),

  rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 15 * 60_000),
  rateLimitAnalyze: int('RATE_LIMIT_ANALYZE', 60),
  rateLimitConvert: int('RATE_LIMIT_CONVERT', 15),

  // Fatores de equivalência perceptiva entre o codec de origem e MP3.
  // Ex.: Opus a 160 kbps soa próximo de um MP3 a ~240 kbps.
  audioCodecFactor: {
    opus: float('AUDIO_FACTOR_OPUS', 1.5),
    mp4a: float('AUDIO_FACTOR_AAC', 1.25),
    mp3: 1,
    default: 1,
  },

  videoQualities: [360, 480, 720, 1080],
  audioBitrates: [128, 192, 256, 320],
});
