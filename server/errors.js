'use strict';

class AppError extends Error {
  constructor(code, message, status = 400, { hint, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.retryable = retryable;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        hint: this.hint,
        retryable: this.retryable,
      },
    };
  }
}

// Traduz mensagens do yt-dlp (stderr) em erros claros para o usuário.
const PATTERNS = [
  [/private video|this video is private/i, 'VIDEO_PRIVATE', 'Este vídeo é privado.', 403,
    'Somente vídeos públicos ou não listados podem ser analisados.'],
  [/sign in to confirm your age|age[- ]restricted|inappropriate for some users/i, 'AGE_RESTRICTED',
    'Este vídeo tem restrição de idade.', 403,
    'Vídeos com restrição de idade exigem login e não podem ser processados.'],
  [/members[- ]only|join this channel/i, 'MEMBERS_ONLY', 'Este vídeo é exclusivo para membros do canal.', 403],
  [/not available in your country|geo.?restrict|blocked it in your country/i, 'GEO_BLOCKED',
    'Este vídeo não está disponível na região do servidor.', 403],
  [/copyright|removed by the uploader|account .* terminated/i, 'VIDEO_REMOVED',
    'Este vídeo foi removido ou bloqueado por direitos autorais.', 410],
  [/video unavailable|does not exist|not available|incomplete youtube id/i, 'VIDEO_UNAVAILABLE',
    'Vídeo indisponível ou inexistente.', 404, 'Confira se o link está correto e se o vídeo ainda está no ar.'],
  [/premiere|will begin in|this live event will begin/i, 'VIDEO_NOT_STARTED',
    'Esta estreia ou transmissão ainda não começou.', 409],
  [/sign in to confirm you.?re not a bot|http error 429|too many requests/i, 'SOURCE_THROTTLED',
    'A plataforma de origem limitou temporariamente as requisições.', 503,
    'Aguarde alguns minutos e tente novamente.', true],
  [/requested format is not available|no video formats found/i, 'FORMAT_UNAVAILABLE',
    'A qualidade escolhida não está disponível para este vídeo.', 422, 'Selecione outra qualidade.'],
  [/file is larger than max-filesize|max-filesize/i, 'FILE_TOO_LARGE',
    'O arquivo final ultrapassa o tamanho máximo permitido.', 413, 'Tente uma qualidade menor.'],
  [/unable to download|connection|timed out|network|name resolution|proxy/i, 'NETWORK_ERROR',
    'Não conseguimos nos comunicar com a plataforma de origem.', 502,
    'Verifique sua conexão ou tente novamente em instantes.', true],
];

function fromYtdlpStderr(stderr = '') {
  for (const [regex, code, message, status, hint, retryable] of PATTERNS) {
    if (regex.test(stderr)) return new AppError(code, message, status, { hint, retryable });
  }
  return new AppError('PROCESSING_FAILED', 'Não foi possível processar este vídeo.', 500, {
    hint: 'Tente novamente. Se o problema persistir, experimente outro formato ou qualidade.',
    retryable: true,
  });
}

module.exports = { AppError, fromYtdlpStderr };
