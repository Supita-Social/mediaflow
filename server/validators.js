'use strict';

const { AppError } = require('./errors');

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
]);

/**
 * Valida a URL e extrai o ID do vídeo do YouTube.
 * Aceita: watch?v=, youtu.be/, shorts/, embed/, live/, v/ e music.youtube.com.
 * Retorna { id, canonicalUrl } ou lança AppError.
 */
function parseVideoUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new AppError('URL_EMPTY', 'Cole o link de um vídeo para continuar.', 400);
  }

  let raw = input.trim();
  if (raw.length > 2048) {
    throw new AppError('URL_INVALID', 'O link informado é longo demais.', 400);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (!/^https?:\/\//i.test(raw)) {
      throw new AppError('URL_INVALID', 'Use um link que comece com http:// ou https://.', 400);
    }
  } else {
    raw = `https://${raw}`;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('URL_INVALID', 'Esse texto não parece um link válido.', 400, {
      hint: 'Copie o endereço completo do vídeo, por exemplo: https://www.youtube.com/watch?v=…',
    });
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AppError('URL_INVALID', 'Use um link que comece com http:// ou https://.', 400);
  }

  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    throw new AppError('SOURCE_UNSUPPORTED', 'No momento, o MediaFlow aceita apenas links do YouTube.', 400, {
      hint: 'Verifique se o link é de youtube.com ou youtu.be.',
    });
  }

  let id = null;
  const segments = url.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') {
    id = segments[0] || null;
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v');
  } else if (['shorts', 'embed', 'live', 'v', 'e'].includes(segments[0])) {
    id = segments[1] || null;
  }

  if (!id && url.searchParams.get('list')) {
    throw new AppError('PLAYLIST_UNSUPPORTED', 'Playlists não são suportadas.', 400, {
      hint: 'Abra um vídeo específico da playlist e copie o link dele.',
    });
  }

  if (!id || !VIDEO_ID.test(id)) {
    throw new AppError('URL_INVALID', 'Não encontramos um vídeo nesse link.', 400, {
      hint: 'Use o link de um vídeo específico, e não de um canal ou página inicial.',
    });
  }

  return { id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` };
}

module.exports = { parseVideoUrl, VIDEO_ID };
