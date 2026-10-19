'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');
const { AppError, fromYtdlpStderr } = require('./errors');

const PROGRESS_PREFIX = 'MFPROG|';

// O yt-dlp regrava o arquivo de cookies ao terminar. Como arquivos secretos
// (ex.: /etc/secrets no Render) são somente leitura, trabalhamos com uma cópia.
let cookiesPath = null;
function prepareCookies() {
  if (!config.cookiesFile) return;
  try {
    const content = fs.readFileSync(config.cookiesFile, 'utf8');
    if (!/youtube\.com/.test(content)) {
      console.warn('[yt-dlp] o arquivo de cookies não contém cookies do youtube.com');
    }
    cookiesPath = path.join(os.tmpdir(), 'mediaflow-cookies.txt');
    fs.writeFileSync(cookiesPath, content, { mode: 0o600 });
    console.log(`[yt-dlp] usando cookies configurados (${content.split('\n').length} linhas)`);
  } catch (err) {
    const reason = { ENOENT: 'não encontrado', EACCES: 'sem permissão de leitura' }[err.code] || err.code;
    let listing = '';
    try { listing = fs.readdirSync(path.dirname(config.cookiesFile)).join(', ') || '(vazia)'; } catch (e) { listing = e.code; }
    console.warn(`[yt-dlp] arquivo de cookies ${reason}: ${config.cookiesFile} — conteúdo da pasta: ${listing}`);
  }
}

function baseArgs() {
  const args = ['--no-playlist', '--no-warnings', '--no-cache-dir', '--ignore-config'];
  if (config.jsRuntimes) {
    for (const runtime of config.jsRuntimes.split(',').map((r) => r.trim()).filter(Boolean)) {
      args.push('--js-runtimes', runtime);
    }
  }
  if (config.ffmpegPath) args.push('--ffmpeg-location', config.ffmpegPath);
  if (cookiesPath) args.push('--cookies', cookiesPath);
  return args;
}

function logFailure(context, stderr) {
  const tail = stderr.trim().split('\n').slice(-6).join('\n');
  console.error(`[yt-dlp] falha em ${context}:\n${tail}`);
}

/** Executa o yt-dlp e devolve stdout completo (usado na análise). */
function run(args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new AppError('ANALYZE_TIMEOUT', 'A análise demorou mais que o esperado.', 504, {
        hint: 'Tente novamente em instantes.',
        retryable: true,
      }));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT'
        ? new AppError('DEPENDENCY_MISSING', 'O serviço de conversão não está configurado corretamente.', 500, {
          hint: 'O administrador precisa instalar o yt-dlp no servidor.',
        })
        : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      logFailure('análise', stderr);
      return reject(fromYtdlpStderr(stderr));
    });
  });
}

async function fetchInfo(url) {
  const stdout = await run([...baseArgs(), '-J', '--skip-download', url], {
    timeoutMs: config.analyzeTimeoutMs,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new AppError('PROCESSING_FAILED', 'Recebemos uma resposta inesperada da plataforma de origem.', 502, {
      retryable: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Resumo das informações: decide quais qualidades a fonte realmente suporta.
// ---------------------------------------------------------------------------

const hasVideo = (f) => f.vcodec && f.vcodec !== 'none' && Number(f.height) > 0;
const hasAudio = (f) => f.acodec && f.acodec !== 'none';
const isAudioOnly = (f) => hasAudio(f) && (!f.vcodec || f.vcodec === 'none');
const isStoryboard = (f) => f.format_note === 'storyboard' || f.ext === 'mhtml';

/** Rótulo “p” de um formato: usa a nota do YouTube (720p) ou o menor lado da imagem. */
function qualityLabel(f) {
  const note = /^(\d{3,4})p/.exec(f.format_note || '');
  if (note) return Number(note[1]);
  const shortSide = Math.min(Number(f.width) || Infinity, Number(f.height));
  return config.videoQualities.find((q) => shortSide <= q) ?? Math.round(shortSide);
}

function estimateBytes(f, duration) {
  if (f.filesize) return f.filesize;
  if (f.filesize_approx) return f.filesize_approx;
  if (f.tbr && duration) return Math.round((f.tbr * 1000 / 8) * duration);
  return null;
}

const codecFamily = (codec = '') => codec.split('.')[0].toLowerCase();

function pickBest(formats, score) {
  return formats.reduce((best, f) => (best === null || score(f) > score(best) ? f : best), null);
}

function summarizeInfo(info) {
  if (info._type === 'playlist') {
    throw new AppError('PLAYLIST_UNSUPPORTED', 'Playlists não são suportadas.', 400, {
      hint: 'Abra um vídeo específico e copie o link dele.',
    });
  }
  if (info.is_live || info.live_status === 'is_live') {
    throw new AppError('LIVE_UNSUPPORTED', 'Transmissões ao vivo não podem ser convertidas.', 422, {
      hint: 'Aguarde o fim da transmissão e tente novamente com a gravação.',
    });
  }
  if (info.live_status === 'is_upcoming') {
    throw new AppError('VIDEO_NOT_STARTED', 'Esta estreia ou transmissão ainda não começou.', 409);
  }

  const duration = Number(info.duration) || 0;
  if (duration > config.maxDurationSeconds) {
    const hours = Math.round(config.maxDurationSeconds / 360) / 10;
    throw new AppError('VIDEO_TOO_LONG', `Vídeos com mais de ${hours} h não são suportados.`, 422, {
      hint: 'Escolha um vídeo mais curto.',
    });
  }

  const formats = (info.formats || []).filter((f) => !isStoryboard(f));
  const audioFormats = formats.filter(isAudioOnly);
  const videoFormats = formats.filter(hasVideo);

  // Melhor áudio para mesclar no MP4 (preferência por AAC/M4A, como no download real).
  const mergeAudio = pickBest(audioFormats, (f) => (codecFamily(f.acodec) === 'mp4a' ? 1e6 : 0) + (f.abr || 0))
    || null;
  const mergeAudioBytes = mergeAudio ? estimateBytes(mergeAudio, duration) || 0 : 0;

  const video = [];
  for (const q of config.videoQualities) {
    const candidates = videoFormats.filter((f) => qualityLabel(f) === q);
    if (!candidates.length) continue;
    const chosen = pickBest(candidates, (f) =>
      (codecFamily(f.vcodec) === 'avc1' ? 1e9 : 0) + (f.fps || 0) * 1e5 + (f.tbr || 0));
    const videoBytes = estimateBytes(chosen, duration);
    const muxed = hasAudio(chosen);
    video.push({
      quality: q,
      label: `${q}p`,
      fps: chosen.fps ? Math.round(chosen.fps) : null,
      hd: q >= 720,
      estimatedBytes: videoBytes ? videoBytes + (muxed ? 0 : mergeAudioBytes) : null,
    });
  }

  // Áudio: só oferece taxas que a fonte sustenta (considerando eficiência do codec).
  const sourceAudio = audioFormats.length
    ? pickBest(audioFormats, (f) => (f.abr || f.tbr || 0) * (config.audioCodecFactor[codecFamily(f.acodec)] || 1))
    : pickBest(formats.filter(hasAudio), (f) => f.abr || 0);

  let audio = [];
  let sourceAbr = null;
  if (sourceAudio) {
    sourceAbr = Math.round(sourceAudio.abr || sourceAudio.tbr || 128);
    const factor = config.audioCodecFactor[codecFamily(sourceAudio.acodec)] || config.audioCodecFactor.default;
    const ceiling = sourceAbr * factor;
    audio = config.audioBitrates
      .filter((kbps, i) => i === 0 || kbps <= ceiling + 8)
      .map((kbps) => ({
        bitrate: kbps,
        label: `${kbps} kbps`,
        estimatedBytes: duration ? Math.round((kbps * 1000 / 8) * duration) : null,
      }));
  }

  return {
    id: info.id,
    title: info.title || 'Vídeo sem título',
    channel: info.channel || info.uploader || null,
    channelUrl: info.channel_url || info.uploader_url || null,
    thumbnail: pickThumbnail(info),
    duration,
    viewCount: info.view_count ?? null,
    uploadDate: info.upload_date || null,
    webpageUrl: info.webpage_url || null,
    sourceAudio: sourceAbr ? { bitrate: sourceAbr, codec: codecFamily(sourceAudio.acodec) || null } : null,
    maxVideoQuality: video.length ? video[video.length - 1].quality : null,
    formats: { mp4: video, mp3: audio },
  };
}

function pickThumbnail(info) {
  const thumbs = (info.thumbnails || []).filter((t) => t.url && /^https:\/\//.test(t.url));
  const jpg = thumbs.filter((t) => !/\.webp(\?|$)/.test(t.url) && (t.width || 0) <= 1280);
  const best = pickBest(jpg.length ? jpg : thumbs, (t) => (t.width || 0) * (t.height || 0) + (t.preference || 0));
  return best?.url || info.thumbnail || null;
}

// ---------------------------------------------------------------------------
// Download / conversão com progresso.
// ---------------------------------------------------------------------------

function buildDownloadArgs({ url, format, quality, outputTemplate }) {
  const args = [
    ...baseArgs(),
    '--newline',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`,
    '--max-filesize', `${config.maxFileSizeMb}M`,
    '--no-mtime',
    '--embed-metadata',
    '-o', outputTemplate,
  ];

  if (format === 'mp3') {
    args.push(
      '-f', 'ba/b',
      '-x', '--audio-format', 'mp3', '--audio-quality', `${quality}K`,
      '--embed-thumbnail', '--convert-thumbnails', 'jpg',
    );
  } else {
    // Prioriza a resolução pedida (sem ultrapassá-la) e codecs compatíveis (H.264 + AAC).
    args.push(
      '-f', 'bv*+ba/b',
      '-S', `res:${quality},vcodec:h264,acodec:aac,ext:mp4:m4a`,
      '--merge-output-format', 'mp4',
    );
  }

  args.push('--', url);
  return args;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Inicia o download. Chama onProgress({ stage, percent, speed, eta }) e
 * devolve { promise, cancel }.
 */
function download({ url, format, quality, outputTemplate, onProgress }) {
  const args = buildDownloadArgs({ url, format, quality, outputTemplate });
  const child = spawn(config.ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const expectedFiles = format === 'mp4' ? 2 : 1;
  let fileIndex = -1;
  let stderr = '';
  let canceled = false;
  let lastPercent = 0;

  const emit = (data) => {
    if (data.percent !== undefined) {
      data.percent = Math.max(lastPercent, Math.min(100, data.percent));
      lastPercent = data.percent;
    }
    onProgress(data);
  };

  const handleLine = (line) => {
    if (line.startsWith(PROGRESS_PREFIX)) {
      const [downloaded, total, estimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|').map(num);
      const size = total || estimate;
      const filePercent = size && downloaded !== null ? downloaded / size : 0;
      const slot = Math.min(Math.max(fileIndex, 0), expectedFiles - 1);
      emit({
        stage: 'downloading',
        percent: ((slot + filePercent) / expectedFiles) * 90,
        speed,
        eta,
        part: expectedFiles > 1 ? { index: slot + 1, total: expectedFiles } : null,
      });
    } else if (/^\[download\] Destination:/.test(line)) {
      fileIndex += 1;
    } else if (/^\[download\] .* has already been downloaded/.test(line)) {
      fileIndex += 1;
    } else if (/^\[(Merger|ExtractAudio|VideoConvertor|FixupM\w*|Metadata|EmbedThumbnail|ThumbnailsConvertor)\]/.test(line)) {
      const step = /^\[(\w+)\]/.exec(line)[1];
      const map = { Merger: 93, ExtractAudio: 93, VideoConvertor: 93, Metadata: 97, EmbedThumbnail: 98, ThumbnailsConvertor: 96 };
      emit({ stage: 'processing', percent: map[step] || 95, step, speed: null, eta: null });
    }
  };

  const lineReader = (stream, onLine) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.search(/[\r\n]/)) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) onLine(line);
      }
    });
    stream.on('end', () => { if (buffer.trim()) onLine(buffer.trim()); });
  };

  lineReader(child.stdout, handleLine);
  lineReader(child.stderr, (line) => {
    stderr += `${line}\n`;
    if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
  });

  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      canceled = true;
      child.kill('SIGKILL');
      reject(new AppError('JOB_TIMEOUT', 'A conversão excedeu o tempo limite.', 504, {
        hint: 'Tente uma qualidade menor ou um vídeo mais curto.',
        retryable: true,
      }));
    }, config.jobTimeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT'
        ? new AppError('DEPENDENCY_MISSING', 'O serviço de conversão não está configurado corretamente.', 500)
        : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (canceled) return reject(new AppError('CANCELED', 'Conversão cancelada.', 499));
      if (code === 0) return resolve();
      logFailure('download', stderr);
      return reject(fromYtdlpStderr(stderr));
    });
  });

  return {
    promise,
    cancel() {
      canceled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    },
  };
}

module.exports = { prepareCookies, fetchInfo, summarizeInfo, buildDownloadArgs, download, qualityLabel };
