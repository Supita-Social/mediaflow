FROM node:22-bookworm-slim

# FFmpeg + Python para o yt-dlp
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates tini \
 && pip3 install --no-cache-dir --break-system-packages -U --pre "yt-dlp[default]" \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production PORT=3000 WORK_DIR=/tmp/mediaflow TRUST_PROXY=true
# Roda como root dentro do contêiner para conseguir ler os Secret Files do Render (/etc/secrets).
RUN mkdir -p /tmp/mediaflow

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "scripts/start.sh"]
