'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);

  const el = {
    header: $('.site-header'),
    form: $('#analyze-form'),
    urlField: $('#url-field'),
    url: $('#url-input'),
    urlHelp: $('#url-help'),
    paste: $('#paste-btn'),
    analyzeBtn: $('#analyze-btn'),
    workspace: $('#workspace'),
    skeleton: $('#skeleton'),
    analyzeError: $('#analyze-error'),
    result: $('#result'),
    thumb: $('#v-thumb'),
    duration: $('#v-duration'),
    title: $('#v-title'),
    channel: $('#v-channel'),
    channelWrap: $('#v-channel-wrap'),
    views: $('#v-views'),
    viewsWrap: $('#v-views-wrap'),
    date: $('#v-date'),
    dateWrap: $('#v-date-wrap'),
    tags: $('#v-tags'),
    formatGroup: $('#format-group'),
    qualityGroup: $('#quality-group'),
    qualityLabel: $('#quality-label'),
    qualityNote: $('#quality-note'),
    consent: $('#consent'),
    convertBtn: $('#convert-btn'),
    progress: $('#progress'),
    pStage: $('#p-stage'),
    pPercent: $('#p-percent'),
    pBar: $('#p-bar'),
    pFill: $('#p-fill'),
    pDetail: $('#p-detail'),
    cancelBtn: $('#cancel-btn'),
    success: $('#success'),
    sMeta: $('#s-meta'),
    downloadLink: $('#download-link'),
    againBtn: $('#again-btn'),
    convertError: $('#convert-error'),
    toast: $('#toast'),
  };

  const state = {
    url: '',
    video: null,
    format: null,
    quality: null,
    job: null,
    stream: null,
    pollTimer: null,
  };

  // ---------------------------------------------------------------------------
  // Utilidades de formatação
  // ---------------------------------------------------------------------------

  const nf = new Intl.NumberFormat('pt-BR');
  const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

  function formatDuration(total) {
    if (!total) return '';
    const s = Math.round(total);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
    return `${value.toLocaleString('pt-BR', { maximumFractionDigits: value < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
  }

  function formatDate(yyyymmdd) {
    if (!/^\d{8}$/.test(yyyymmdd || '')) return '';
    const d = new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T12:00:00`);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 60) return `${Math.round(seconds)} s restantes`;
    return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s restantes`;
  }

  function show(node, visible = true) { node.hidden = !visible; }

  let toastTimer;
  function toast(message) {
    el.toast.textContent = message;
    show(el.toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => show(el.toast, false), 3200);
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  class ApiError extends Error {
    constructor({ code, message, hint, retryable }) {
      super(message);
      this.code = code;
      this.hint = hint;
      this.retryable = retryable;
    }
  }

  async function api(path, options = {}) {
    let res;
    try {
      res = await fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        credentials: 'same-origin',
      });
    } catch {
      throw new ApiError({
        code: 'OFFLINE',
        message: 'Não foi possível conectar ao servidor.',
        hint: 'Verifique sua conexão com a internet e tente novamente.',
        retryable: true,
      });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(data.error || {
        code: 'HTTP_' + res.status,
        message: 'Algo deu errado. Tente novamente.',
        retryable: true,
      });
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Validação do link (no cliente; o servidor revalida)
  // ---------------------------------------------------------------------------

  const YT = /^(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&#/].*)?$/i;

  function validateUrl(value) {
    const v = value.trim();
    if (!v) return 'Cole o link de um vídeo para continuar.';
    if (!/youtu\.?be/i.test(v)) return 'No momento, aceitamos apenas links do YouTube.';
    if (!YT.test(v)) {
      if (/[?&]list=/.test(v)) return 'Playlists não são suportadas. Use o link de um vídeo específico.';
      return 'Esse link não parece ser de um vídeo do YouTube.';
    }
    return null;
  }

  const DEFAULT_HELP = el.urlHelp.textContent;
  function setUrlError(message) {
    el.urlField.classList.toggle('invalid', Boolean(message));
    el.urlHelp.textContent = message || DEFAULT_HELP;
    el.url.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  // ---------------------------------------------------------------------------
  // Análise
  // ---------------------------------------------------------------------------

  function showAlert(node, err, { retry = false } = {}) {
    node.querySelector('[data-slot="message"]').textContent = err.message;
    node.querySelector('[data-slot="hint"]').textContent = err.hint || '';
    const retryBtn = node.querySelector('[data-action="retry-analyze"]');
    if (retryBtn) show(retryBtn, retry && err.retryable);
    show(node);
  }

  async function analyze() {
    const error = validateUrl(el.url.value);
    if (error) {
      setUrlError(error);
      el.url.focus();
      return;
    }
    setUrlError(null);

    if (isJobActive()) await cancelJob({ silent: true });
    resetJobUi();

    state.url = el.url.value.trim();
    el.analyzeBtn.classList.add('loading');
    el.analyzeBtn.setAttribute('aria-busy', 'true');
    show(el.workspace);
    show(el.result, false);
    show(el.analyzeError, false);
    show(el.skeleton);
    el.workspace.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      const { video } = await api('/api/analyze', {
        method: 'POST',
        body: JSON.stringify({ url: state.url }),
      });
      state.video = video;
      renderVideo(video);
    } catch (err) {
      state.video = null;
      if (['URL_INVALID', 'URL_EMPTY', 'SOURCE_UNSUPPORTED', 'PLAYLIST_UNSUPPORTED'].includes(err.code)) {
        show(el.workspace, false);
        setUrlError(err.message);
      } else {
        showAlert(el.analyzeError, err, { retry: true });
      }
    } finally {
      show(el.skeleton, false);
      el.analyzeBtn.classList.remove('loading');
      el.analyzeBtn.removeAttribute('aria-busy');
    }
  }

  function renderVideo(video) {
    el.thumb.classList.remove('loaded');
    if (video.thumbnail) {
      el.thumb.src = video.thumbnail;
      el.thumb.alt = `Miniatura de ${video.title}`;
    } else {
      el.thumb.removeAttribute('src');
    }
    el.duration.textContent = formatDuration(video.duration);
    show(el.duration, Boolean(video.duration));
    el.title.textContent = video.title;

    el.channel.textContent = video.channel || '';
    show(el.channelWrap, Boolean(video.channel));
    el.views.textContent = video.viewCount != null
      ? `${video.viewCount >= 10000 ? compact.format(video.viewCount) : nf.format(video.viewCount)} visualizações`
      : '';
    show(el.viewsWrap, video.viewCount != null);
    el.date.textContent = formatDate(video.uploadDate);
    show(el.dateWrap, Boolean(video.uploadDate));

    el.tags.replaceChildren();
    const addTag = (text, accent) => {
      const t = document.createElement('span');
      t.className = `tag${accent ? ' accent' : ''}`;
      t.textContent = text;
      el.tags.append(t);
    };
    if (video.maxVideoQuality) addTag(`até ${video.maxVideoQuality}p`, video.maxVideoQuality >= 720);
    if (video.sourceAudio) addTag(`áudio ${video.sourceAudio.bitrate} kbps ${video.sourceAudio.codec || ''}`.trim());

    const mp4 = video.formats.mp4.length > 0;
    const mp3 = video.formats.mp3.length > 0;
    el.formatGroup.querySelector('[value="mp4"]').disabled = !mp4;
    el.formatGroup.querySelector('[value="mp3"]').disabled = !mp3;

    const preferred = state.format && video.formats[state.format].length ? state.format : (mp4 ? 'mp4' : 'mp3');
    selectFormat(preferred);

    show(el.result);
    requestAnimationFrame(() => el.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }

  // ---------------------------------------------------------------------------
  // Formato e qualidade
  // ---------------------------------------------------------------------------

  function selectFormat(format) {
    state.format = format;
    el.formatGroup.querySelector(`[value="${format}"]`).checked = true;
    renderQualities();
    resetJobUi();
  }

  function renderQualities() {
    const { video, format } = state;
    const options = video.formats[format];
    el.qualityLabel.textContent = format === 'mp4' ? 'Resolução' : 'Qualidade do áudio';
    el.qualityGroup.replaceChildren();

    if (!options.length) {
      const empty = document.createElement('p');
      empty.className = 'quality-empty';
      empty.textContent = 'Nenhuma qualidade disponível para este formato.';
      el.qualityGroup.append(empty);
      state.quality = null;
      updateConvertButton();
      return;
    }

    const values = options.map((o) => (format === 'mp4' ? o.quality : o.bitrate));
    if (!values.includes(state.quality)) {
      state.quality = format === 'mp4'
        ? values[values.length - 1]
        : (values.includes(192) ? 192 : values[values.length - 1]);
    }

    options.forEach((opt) => {
      const value = format === 'mp4' ? opt.quality : opt.bitrate;
      const id = `q-${format}-${value}`;
      const wrap = document.createElement('div');
      wrap.className = 'q-option';

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'quality';
      input.id = id;
      input.value = String(value);
      input.checked = value === state.quality;

      const label = document.createElement('label');
      label.htmlFor = id;
      const main = document.createElement('span');
      main.className = 'q-main';
      main.textContent = format === 'mp4' ? `${value}p` : `${value}`;
      if (format === 'mp4' && value >= 720) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = value >= 1080 ? 'FULL HD' : 'HD';
        main.append(badge);
      }
      if (format === 'mp3') {
        const unit = document.createElement('small');
        unit.className = 'q-sub';
        unit.textContent = 'kbps';
        main.append(unit);
      }
      const sub = document.createElement('span');
      sub.className = 'q-sub';
      const parts = [];
      if (opt.estimatedBytes) parts.push(`~${formatBytes(opt.estimatedBytes)}`);
      if (format === 'mp4' && opt.fps && opt.fps > 30) parts.push(`${opt.fps} fps`);
      sub.textContent = parts.join(' · ') || ' ';

      label.append(main, sub);
      wrap.append(input, label);
      el.qualityGroup.append(wrap);
    });

    const hidden = 4 - options.length;
    if (format === 'mp3' && video.sourceAudio && hidden > 0) {
      el.qualityNote.textContent = `Taxas acima de ${values[values.length - 1]} kbps foram ocultadas: a fonte tem áudio de ~${video.sourceAudio.bitrate} kbps e não ganharia qualidade.`;
    } else if (format === 'mp4' && hidden > 0) {
      el.qualityNote.textContent = 'Exibindo apenas as resoluções disponíveis na fonte.';
    } else {
      el.qualityNote.textContent = '';
    }
    show(el.qualityNote, Boolean(el.qualityNote.textContent));
    updateConvertButton();
  }

  function updateConvertButton() {
    el.convertBtn.disabled = !(state.video && state.quality && el.consent.checked) || isJobActive();
  }

  function setOptionsLocked(locked) {
    el.formatGroup.querySelectorAll('input').forEach((input) => {
      input.disabled = locked || !state.video?.formats[input.value]?.length;
    });
    el.qualityGroup.querySelectorAll('input').forEach((input) => { input.disabled = locked; });
    el.consent.disabled = locked;
  }

  // ---------------------------------------------------------------------------
  // Conversão
  // ---------------------------------------------------------------------------

  const isJobActive = () => Boolean(state.job && ['queued', 'downloading', 'processing'].includes(state.job.status));

  function resetJobUi() {
    closeStream();
    state.job = null;
    show(el.convertBtn);
    show(el.progress, false);
    show(el.success, false);
    show(el.convertError, false);
    setOptionsLocked(false);
    updateConvertButton();
  }

  async function convert() {
    if (el.convertBtn.disabled) return;
    show(el.convertError, false);
    el.convertBtn.disabled = true;
    setOptionsLocked(true);

    try {
      const { job } = await api('/api/convert', {
        method: 'POST',
        body: JSON.stringify({
          url: state.url,
          format: state.format,
          quality: state.quality,
          authorized: el.consent.checked,
        }),
      });
      show(el.convertBtn, false);
      updateJob(job);
      openStream(job.id);
    } catch (err) {
      setOptionsLocked(false);
      updateConvertButton();
      showAlert(el.convertError, err);
    }
  }

  function openStream(id) {
    closeStream();
    if (!('EventSource' in window)) return startPolling(id);
    const stream = new EventSource(`/api/jobs/${id}/events`);
    state.stream = stream;
    stream.onmessage = (event) => {
      try { updateJob(JSON.parse(event.data)); } catch { /* ignora mensagens malformadas */ }
    };
    stream.onerror = () => {
      if (state.stream !== stream) return;
      closeStream();
      if (isJobActive()) startPolling(id);
    };
  }

  function startPolling(id) {
    clearTimeout(state.pollTimer);
    const tick = async () => {
      try {
        const { job } = await api(`/api/jobs/${id}`);
        updateJob(job);
      } catch (err) {
        updateJob({ ...state.job, status: 'error', error: err });
      }
      if (isJobActive()) state.pollTimer = setTimeout(tick, 1000);
    };
    tick();
  }

  function closeStream() {
    if (state.stream) { state.stream.close(); state.stream = null; }
    clearTimeout(state.pollTimer);
  }

  const STEP_LABELS = {
    Merger: 'Unindo áudio e vídeo…',
    ExtractAudio: 'Convertendo para MP3…',
    VideoConvertor: 'Convertendo vídeo…',
    ThumbnailsConvertor: 'Preparando capa…',
    EmbedThumbnail: 'Incorporando capa…',
    Metadata: 'Adicionando metadados…',
  };

  function stageLabel(job) {
    if (job.status === 'queued') {
      return job.queuePosition > 1 ? `Na fila · posição ${job.queuePosition}` : 'Na fila · você é o próximo';
    }
    if (job.status === 'downloading') {
      if (job.format === 'mp3') return 'Baixando áudio…';
      if (job.part && job.part.total > 1) return job.part.index === 1 ? 'Baixando vídeo (1/2)…' : 'Baixando áudio (2/2)…';
      return 'Baixando vídeo…';
    }
    if (job.status === 'processing') return STEP_LABELS[job.step] || 'Finalizando…';
    return '';
  }

  function updateJob(job) {
    // Ignora atualizações de conversões antigas.
    if (!job || (state.job && job.id && state.job.id !== job.id)) return;
    state.job = job;

    if (isJobActive()) {
      show(el.progress);
      show(el.success, false);
      const percent = Math.max(0, Math.min(100, job.percent || 0));
      el.pStage.textContent = stageLabel(job);
      el.pPercent.textContent = job.status === 'queued' ? '—' : `${Math.floor(percent)}%`;
      el.pFill.style.width = `${percent}%`;
      el.pBar.setAttribute('aria-valuenow', String(Math.floor(percent)));
      el.pBar.classList.toggle('indeterminate', job.status === 'queued' || (job.status === 'downloading' && percent === 0));
      el.pBar.classList.toggle('processing', job.status === 'processing');
      const detail = [];
      if (job.speed) detail.push(`${formatBytes(job.speed)}/s`);
      const eta = formatEta(job.eta);
      if (eta) detail.push(eta);
      el.pDetail.textContent = detail.join(' · ') || ' ';
      return;
    }

    closeStream();
    show(el.progress, false);

    if (job.status === 'done' && job.file) {
      el.downloadLink.href = job.file.url;
      el.downloadLink.setAttribute('download', job.file.name);
      const exp = job.expiresAt
        ? ` · disponível até ${new Date(job.expiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
        : '';
      el.sMeta.textContent = `${job.format.toUpperCase()} · ${formatBytes(job.file.size)}${exp}`;
      el.sMeta.title = job.file.name;
      show(el.success);
      setOptionsLocked(false);
      el.downloadLink.focus({ preventScroll: true });
    } else if (job.status === 'canceled') {
      resetJobUi();
      toast('Conversão cancelada.');
    } else if (job.status === 'error') {
      setOptionsLocked(false);
      show(el.convertBtn);
      updateConvertButton();
      showAlert(el.convertError, job.error || { message: 'A conversão falhou. Tente novamente.' });
    }
  }

  async function cancelJob({ silent = false } = {}) {
    const job = state.job;
    if (!job) return;
    closeStream();
    try {
      await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
    } catch { /* a conversão pode já ter terminado */ }
    state.job = null;
    if (!silent) {
      resetJobUi();
      toast('Conversão cancelada.');
    }
  }

  // ---------------------------------------------------------------------------
  // Eventos
  // ---------------------------------------------------------------------------

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    analyze();
  });

  el.url.addEventListener('input', () => {
    if (el.urlField.classList.contains('invalid')) setUrlError(null);
  });

  el.url.addEventListener('paste', () => {
    setTimeout(() => {
      if (!validateUrl(el.url.value) && el.url.value.trim() !== state.url) analyze();
    }, 0);
  });

  if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
    show(el.paste);
    el.paste.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return toast('A área de transferência está vazia.');
        el.url.value = text.trim();
        analyze();
      } catch {
        toast('Permita o acesso à área de transferência ou cole com Ctrl+V.');
        el.url.focus();
      }
    });
  }

  el.analyzeError.querySelector('[data-action="retry-analyze"]').addEventListener('click', analyze);

  el.formatGroup.addEventListener('change', (event) => {
    if (event.target.name === 'format') selectFormat(event.target.value);
  });

  el.qualityGroup.addEventListener('change', (event) => {
    if (event.target.name === 'quality') {
      state.quality = Number(event.target.value);
      resetJobUi();
    }
  });

  el.consent.addEventListener('change', updateConvertButton);
  el.convertBtn.addEventListener('click', convert);
  el.cancelBtn.addEventListener('click', () => cancelJob());
  el.againBtn.addEventListener('click', () => {
    resetJobUi();
    el.formatGroup.querySelector(`[value="${state.format}"]`).focus();
  });

  el.thumb.addEventListener('load', () => el.thumb.classList.add('loaded'));

  window.addEventListener('scroll', () => {
    el.header.classList.toggle('scrolled', window.scrollY > 8);
  }, { passive: true });

  // Ajusta os textos de limites com a configuração do servidor.
  api('/api/config').then((cfg) => {
    const ttl = document.querySelector('[data-config="ttl"]');
    const dur = document.querySelector('[data-config="duration"]');
    if (ttl) ttl.textContent = String(cfg.fileTtlMinutes);
    if (dur) {
      const h = cfg.maxDurationSeconds / 3600;
      dur.textContent = h >= 1 ? `${nf.format(h)} ${h === 1 ? 'hora' : 'horas'}` : `${Math.round(cfg.maxDurationSeconds / 60)} minutos`;
    }
  }).catch(() => {});

  document.getElementById('year').textContent = String(new Date().getFullYear());

  // Permite abrir com ?url=… já preenchido.
  const initial = new URLSearchParams(location.search).get('url');
  if (initial) {
    el.url.value = initial;
    analyze();
  }
})();
