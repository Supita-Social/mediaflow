'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const config = require('./config');
const { AppError } = require('./errors');
const { parseVideoUrl } = require('./validators');
const ytdlp = require('./ytdlp');
const { JobManager } = require('./jobs');

const app = express();
const jobs = new JobManager();

// Cache curto das análises, para que a conversão use as mesmas opções exibidas.
const INFO_TTL_MS = 15 * 60_000;
const infoCache = new Map();

async function getSummary(videoId, url) {
  const cached = infoCache.get(videoId);
  if (cached && Date.now() - cached.at < INFO_TTL_MS) return cached.summary;
  const summary = ytdlp.summarizeInfo(await ytdlp.fetchInfo(url));
  infoCache.set(videoId, { summary, at: Date.now() });
  if (infoCache.size > 500) infoCache.delete(infoCache.keys().next().value);
  return summary;
}

if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https://i.ytimg.com', 'https://*.ytimg.com', 'https://*.ggpht.com'],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'"],
      scriptSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '10kb' }));

// Identificador anônimo por navegador (cookie) para limitar conversões simultâneas.
app.use((req, res, next) => {
  const match = /(?:^|;\s*)mf_client=([a-f0-9-]{36})/.exec(req.headers.cookie || '');
  req.clientId = match ? match[1] : crypto.randomUUID();
  if (!match) {
    res.cookie('mf_client', req.clientId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: 30 * 24 * 3600 * 1000,
    });
  }
  next();
});

const limiter = (limit) => rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    const err = new AppError('RATE_LIMITED', 'Muitas solicitações em pouco tempo.', 429, {
      hint: 'Aguarde alguns minutos antes de tentar novamente.',
    });
    res.status(429).json(err.toJSON());
  },
});

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, running: jobs.running, queued: jobs.queue.length });
});

app.get('/api/config', (req, res) => {
  res.json({
    maxDurationSeconds: config.maxDurationSeconds,
    maxFileSizeMb: config.maxFileSizeMb,
    fileTtlMinutes: config.fileTtlMinutes,
  });
});

app.post('/api/analyze', limiter(config.rateLimitAnalyze), asyncRoute(async (req, res) => {
  const { id, canonicalUrl } = parseVideoUrl(req.body?.url);
  const summary = await getSummary(id, canonicalUrl);
  if (!summary.formats.mp4.length && !summary.formats.mp3.length) {
    throw new AppError('FORMAT_UNAVAILABLE', 'Não encontramos formatos compatíveis para este vídeo.', 422);
  }
  res.json({ video: summary });
}));

app.post('/api/convert', limiter(config.rateLimitConvert), asyncRoute(async (req, res) => {
  const { url, format, quality, authorized } = req.body || {};

  if (authorized !== true) {
    throw new AppError('AUTHORIZATION_REQUIRED', 'Confirme que você tem autorização para baixar este conteúdo.', 400);
  }
  if (!['mp3', 'mp4'].includes(format)) {
    throw new AppError('FORMAT_INVALID', 'Escolha MP3 ou MP4.', 400);
  }

  const { id, canonicalUrl } = parseVideoUrl(url);
  const summary = await getSummary(id, canonicalUrl);
  const q = Number(quality);
  const options = format === 'mp4'
    ? summary.formats.mp4.map((o) => o.quality)
    : summary.formats.mp3.map((o) => o.bitrate);

  if (!options.includes(q)) {
    throw new AppError('QUALITY_UNAVAILABLE', 'A qualidade escolhida não está disponível para este vídeo.', 422, {
      hint: 'Selecione uma das opções exibidas.',
    });
  }

  const job = jobs.create({
    clientId: req.clientId,
    url: canonicalUrl,
    videoId: id,
    title: summary.title,
    duration: summary.duration,
    format,
    quality: q,
  });
  res.status(202).json({ job: jobs.publicView(job) });
}));

function findJob(req) {
  const job = jobs.get(req.params.id);
  if (!job || job.clientId !== req.clientId) {
    throw new AppError('JOB_NOT_FOUND', 'Conversão não encontrada ou expirada.', 404, {
      hint: 'Os arquivos ficam disponíveis por tempo limitado. Converta o vídeo novamente.',
    });
  }
  return job;
}

app.get('/api/jobs/:id', (req, res) => {
  res.json({ job: jobs.publicView(findJob(req)) });
});

// Server-Sent Events com o progresso em tempo real.
app.get('/api/jobs/:id/events', (req, res) => {
  const job = findJob(req);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (view) => {
    res.write(`data: ${JSON.stringify(view)}\n\n`);
    if (['done', 'error', 'canceled'].includes(view.status)) close();
  };
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  const unsubscribe = jobs.subscribe(job.id, send);
  function close() {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  }
  req.on('close', close);
  send(jobs.publicView(job));
});

app.delete('/api/jobs/:id', (req, res) => {
  const job = findJob(req);
  jobs.cancel(job.id);
  res.json({ job: jobs.publicView(job) });
});

app.get('/api/jobs/:id/download', (req, res) => {
  const job = findJob(req);
  if (job.status !== 'done') {
    throw new AppError('JOB_NOT_READY', 'O arquivo ainda não está pronto.', 409);
  }
  const ascii = job.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.set({
    'Content-Type': job.format === 'mp3' ? 'audio/mpeg' : 'video/mp4',
    'Content-Length': job.fileSize,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(job.fileName)}`,
    'Cache-Control': 'private, no-store',
  });
  const stream = jobs.fileStream(job);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

app.use('/api', (req, res) => {
  res.status(404).json(new AppError('NOT_FOUND', 'Rota não encontrada.', 404).toJSON());
});

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: '1h' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof AppError) return res.status(err.status).json(err.toJSON());
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json(new AppError('BAD_REQUEST', 'Requisição inválida.', 400).toJSON());
  }
  console.error(err);
  return res.status(500).json(new AppError('INTERNAL', 'Erro interno do servidor.', 500, { retryable: true }).toJSON());
});

async function main() {
  await jobs.init();
  const server = app.listen(config.port, config.host, () => {
    console.log(`MediaFlow rodando em http://localhost:${config.port}`);
  });
  const shutdown = () => {
    for (const job of jobs.jobs.values()) job.handle?.cancel();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { app, jobs };
