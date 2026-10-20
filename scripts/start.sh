#!/bin/sh
# Atualiza o yt-dlp (versão nightly, que recebe correções do YouTube mais rápido)
# antes de iniciar o servidor. Se a atualização falhar, segue com a versão instalada.
if [ "${YTDLP_AUTO_UPDATE:-true}" = "true" ]; then
  echo "[start] atualizando yt-dlp..."
  timeout 90 pip3 install -q --no-cache-dir --break-system-packages -U --pre "yt-dlp[default]" \
    || echo "[start] não foi possível atualizar o yt-dlp; usando a versão instalada"
fi
echo "[start] yt-dlp $(yt-dlp --version 2>/dev/null || echo 'não encontrado')"
exec node server/index.js
