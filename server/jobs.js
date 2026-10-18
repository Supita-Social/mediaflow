'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const config = require('./config');
const { AppError } = require('./errors');
const ytdlp = require('./ytdlp');

const MAX_ACTIVE_PER_CLIENT = 3;

/** Nome de arquivo seguro e legível a partir do título do vídeo. */
function safeFilename(title, ext) {
  const base = String(title || 'mediaflow')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  return `${base || 'mediaflow'}.${ext}`;
}

class JobManager {
  constructor() {
    this.jobs = new Map();
    this.queue = [];
    this.running = 0;
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
  }

  async init() {
    await fsp.rm(config.workDir, { recursive: true, force: true });
    await fsp.mkdir(config.workDir, { recursive: true });
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
  }

  activeCountFor(clientId) {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.clientId === clientId && ['queued', 'downloading', 'processing'].includes(job.status)) count += 1;
    }
    return count;
  }

  create({ clientId, url, videoId, title, duration, format, quality }) {
    if (this.queue.length >= config.maxQueueSize) {
      throw new AppError('QUEUE_FULL', 'O servidor está ocupado no momento.', 503, {
        hint: 'Aguarde alguns instantes e tente novamente.',
        retryable: true,
      });
    }
    if (this.activeCountFor(clientId) >= MAX_ACTIVE_PER_CLIENT) {
      throw new AppError('TOO_MANY_JOBS', 'Você já tem conversões em andamento.', 429, {
        hint: 'Aguarde a conclusão das conversões atuais antes de iniciar outra.',
      });
    }

    const id = crypto.randomUUID();
    const job = {
      id,
      clientId,
      url,
      videoId,
      title,
      duration,
      format,
      quality,
      status: 'queued',
      percent: 0,
      speed: null,
      eta: null,
      step: null,
      part: null,
      error: null,
      dir: path.join(config.workDir, id),
      filePath: null,
      fileName: null,
      fileSize: null,
      createdAt: Date.now(),
      finishedAt: null,
      handle: null,
    };
    this.jobs.set(id, job);
    this.queue.push(job);
    this.publish(job);
    this.pump();
    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  publicView(job) {
    const position = job.status === 'queued' ? this.queue.indexOf(job) + 1 : null;
    return {
      id: job.id,
      status: job.status,
      format: job.format,
      quality: job.quality,
      title: job.title,
      percent: Math.round(job.percent * 10) / 10,
      speed: job.speed,
      eta: job.eta,
      step: job.step,
      part: job.part,
      queuePosition: position,
      error: job.error,
      file: job.status === 'done'
        ? { name: job.fileName, size: job.fileSize, url: `/api/jobs/${job.id}/download` }
        : null,
      expiresAt: job.finishedAt ? job.finishedAt + config.fileTtlMinutes * 60_000 : null,
    };
  }

  publish(job) {
    this.events.emit(job.id, this.publicView(job));
  }

  subscribe(id, listener) {
    this.events.on(id, listener);
    return () => this.events.off(id, listener);
  }

  pump() {
    while (this.running < config.maxConcurrentJobs && this.queue.length) {
      const job = this.queue.shift();
      this.queue.forEach((queued) => this.publish(queued));
      this.start(job);
    }
  }

  async start(job) {
    this.running += 1;
    job.status = 'downloading';
    this.publish(job);

    let lastPublish = 0;
    try {
      await fsp.mkdir(job.dir, { recursive: true });
      job.handle = ytdlp.download({
        url: job.url,
        format: job.format,
        quality: job.quality,
        outputTemplate: path.join(job.dir, 'media.%(ext)s'),
        onProgress: (p) => {
          job.status = p.stage;
          job.percent = p.percent ?? job.percent;
          job.speed = p.speed ?? null;
          job.eta = p.eta ?? null;
          job.step = p.step ?? null;
          job.part = p.part ?? null;
          const now = Date.now();
          if (p.stage === 'processing' || now - lastPublish > 250) {
            lastPublish = now;
            this.publish(job);
          }
        },
      });
      await job.handle.promise;

      const output = await this.findOutput(job);
      job.filePath = output;
      job.fileSize = (await fsp.stat(output)).size;
      job.fileName = safeFilename(job.title, job.format);
      job.status = 'done';
      job.percent = 100;
      job.speed = null;
      job.eta = null;
    } catch (err) {
      const appErr = err instanceof AppError
        ? err
        : new AppError('PROCESSING_FAILED', 'Ocorreu um erro inesperado durante a conversão.', 500, { retryable: true });
      if (!(err instanceof AppError)) console.error(`[job ${job.id}]`, err);
      job.status = appErr.code === 'CANCELED' ? 'canceled' : 'error';
      job.error = appErr.toJSON().error;
      await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    } finally {
      job.handle = null;
      job.finishedAt = Date.now();
      this.running -= 1;
      this.publish(job);
      this.pump();
    }
  }

  async findOutput(job) {
    const files = await fsp.readdir(job.dir);
    const match = files.find((name) => name.endsWith(`.${job.format}`) && !name.endsWith('.part'));
    if (!match) {
      throw new AppError('OUTPUT_MISSING', 'A conversão terminou, mas o arquivo final não foi gerado.', 500, {
        retryable: true,
      });
    }
    return path.join(job.dir, match);
  }

  cancel(id) {
    const job = this.get(id);
    if (!job) return null;
    if (job.status === 'queued') {
      this.queue = this.queue.filter((queued) => queued !== job);
      job.status = 'canceled';
      job.finishedAt = Date.now();
      this.publish(job);
    } else if (job.handle) {
      job.handle.cancel();
    }
    return job;
  }

  async cleanup() {
    const ttl = config.fileTtlMinutes * 60_000;
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.finishedAt && now - job.finishedAt > ttl) {
        this.jobs.delete(job.id);
        await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  fileStream(job) {
    return fs.createReadStream(job.filePath);
  }
}

module.exports = { JobManager, safeFilename };
