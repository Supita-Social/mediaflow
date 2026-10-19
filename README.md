# MediaFlow

**Seus vídeos, do seu jeito.** Aplicação web para converter vídeos do YouTube em **MP3** (128–320 kbps) ou **MP4** (360p–1080p), mostrando apenas as qualidades que a fonte realmente oferece.

> ⚖️ **Uso responsável.** Converta apenas conteúdos que você criou, que estão sob licença livre (por exemplo, Creative Commons) ou para os quais tem autorização do titular. Os Termos de Serviço do YouTube restringem downloads fora dos recursos oficiais. Quem publica e opera a aplicação é responsável por garantir o uso dentro da lei. A interface exige que o usuário confirme essa autorização antes de cada conversão, e o servidor rejeita pedidos sem essa confirmação.

---

## Recursos

- Validação de links no cliente e no servidor: `youtube.com/watch`, `youtu.be`, Shorts, `embed`, `live` e `music.youtube.com`. Playlists, canais e outros domínios são rejeitados com mensagens claras.
- Análise do vídeo: título, miniatura, canal, duração, visualizações, data, resolução máxima e áudio de origem.
- **Qualidades reais**:
  - MP4: só aparecem resoluções que existem na fonte. Vídeos verticais e com proporção de cinema são classificados corretamente.
  - MP3: as taxas de bits ficam limitadas à qualidade do áudio original. A eficiência do codec é levada em conta (Opus 160 kbps ≈ MP3 240 kbps), então o app não oferece "320 kbps" a partir de um áudio de 128 kbps.
- Tamanho estimado de cada opção.
- Fila de processamento com limite de conversões simultâneas, posição na fila e **progresso em tempo real** via Server-Sent Events, com polling como alternativa. As etapas aparecem separadas: baixando vídeo, baixando áudio, unindo, convertendo para MP3, metadados e capa.
- O MP4 prioriza H.264 + AAC, que toca em qualquer dispositivo. O MP3 sai com metadados e capa incorporados.
- Cancelamento de conversões em andamento.
- Erros traduzidos para o usuário: vídeo privado, removido, com restrição de idade, exclusivo para membros, bloqueado por região, ao vivo, longo demais, limite da plataforma, falha de rede e outros.
- Segurança: Helmet/CSP, limite de requisições por IP, no máximo 3 conversões ativas por navegador, cada conversão visível só para quem a criou, nomes de arquivo sanitizados e argumentos passados ao yt-dlp sem shell.
- Os arquivos temporários são apagados automaticamente depois de `FILE_TTL_MINUTES`, que por padrão é 30 minutos.
- Interface responsiva em PT-BR, com tema escuro, estados de carregamento (skeleton), sucesso, erro e processamento, acessível por teclado e com suporte a `prefers-reduced-motion`.

## Arquitetura

```
mediaflow/
├── server/
│   ├── index.js        # Express: rotas da API, SSE, segurança e arquivos estáticos
│   ├── config.js       # Configuração via variáveis de ambiente / .env
│   ├── validators.js   # Validação e normalização de URLs do YouTube
│   ├── ytdlp.js        # Integração com yt-dlp: análise, seleção de qualidades, download e progresso
│   ├── jobs.js         # Fila de conversões, eventos, cancelamento e limpeza
│   └── errors.js       # Erros da aplicação e tradução das mensagens do yt-dlp
├── public/             # Frontend (HTML/CSS/JS puro, sem etapa de build)
├── test/               # Testes unitários e de ponta a ponta (node:test)
│   └── fixtures/fake-yt-dlp.js   # Simulador do yt-dlp para testes offline
├── scripts/check-deps.js
├── Dockerfile · docker-compose.yml · .env.example
```

O processamento usa o [yt-dlp](https://github.com/yt-dlp/yt-dlp), que obtém os streams, e o [FFmpeg](https://ffmpeg.org/), que une áudio e vídeo e converte para MP3.

### API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/api/analyze` | `{ url }` → informações do vídeo e qualidades disponíveis |
| `POST` | `/api/convert` | `{ url, format: "mp3"\|"mp4", quality, authorized: true }` → cria a conversão (202) |
| `GET` | `/api/jobs/:id` | Estado atual da conversão |
| `GET` | `/api/jobs/:id/events` | Progresso em tempo real (SSE) |
| `DELETE` | `/api/jobs/:id` | Cancela a conversão |
| `GET` | `/api/jobs/:id/download` | Baixa o arquivo final |
| `GET` | `/api/health` | Health check |

Os erros sempre seguem o formato `{ "error": { "code", "message", "hint", "retryable" } }`.

## Executar localmente

Requisitos: **Node.js 18.17+**, **Python 3.9+** (para o yt-dlp) e **FFmpeg**.

```bash
# 1. Dependências do sistema
# macOS
brew install ffmpeg yt-dlp
# Ubuntu/Debian
sudo apt install ffmpeg python3-pip && pip install -U "yt-dlp[default]"
# Windows (winget)
winget install Gyan.FFmpeg yt-dlp.yt-dlp

# 2. Projeto
npm install
cp .env.example .env     # opcional: ajuste os limites
npm run check            # confere se yt-dlp e FFmpeg foram encontrados
npm start                # http://localhost:3000
```

Para desenvolvimento com recarga automática, use `npm run dev`.

### Testes

```bash
npm test
```

Os testes de ponta a ponta usam um simulador do yt-dlp (`test/fixtures/fake-yt-dlp.js`) e o FFmpeg real. Assim dá para validar análise, regras de qualidade, conversão em MP3 e MP4, progresso via SSE, cancelamento e isolamento entre usuários sem acesso à internet.

Para testar a interface offline com esse simulador:

```bash
YTDLP_PATH=./test/fixtures/fake-yt-dlp.js npm start
```

## Publicar

A aplicação precisa de um servidor que execute processos (yt-dlp/FFmpeg) e tenha disco temporário. Por isso **não funciona em hospedagem estática nem em funções serverless** como Vercel ou Netlify Functions.

### Docker (recomendado)

```bash
docker compose up -d --build
# ou
docker build -t mediaflow . && docker run -p 3000:3000 --env-file .env mediaflow
```

A imagem já inclui FFmpeg e yt-dlp, roda com um usuário sem privilégios e tem um health check.

### Render / Railway / Fly.io

1. Suba o repositório para o GitHub.
2. Crie um serviço web do tipo **Docker** apontando para o repositório. O `Dockerfile` é detectado automaticamente.
3. Defina as variáveis de ambiente necessárias. `TRUST_PROXY=true` já vem definido na imagem.
4. Configure o health check em `/api/health`.

### VPS (Ubuntu) com Nginx

```bash
sudo apt install -y nodejs npm ffmpeg python3-pip nginx
pip install -U "yt-dlp[default]"
git clone <seu-repo> /opt/mediaflow && cd /opt/mediaflow && npm ci --omit=dev
TRUST_PROXY=true npx pm2 start server/index.js --name mediaflow
```

Trecho do Nginx. O `proxy_buffering off` é necessário para o progresso via SSE:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

### Dicas de produção

- **Mantenha o yt-dlp atualizado.** O YouTube muda com frequência: rode `pip install -U yt-dlp` periodicamente ou reconstrua a imagem Docker.
- IPs de datacenter podem receber o aviso "confirme que você não é um robô". Nesses casos o app mostra o erro `SOURCE_THROTTLED`. Se esse aviso aparecer, configure `YTDLP_COOKIES_FILE` com cookies de uma conta própria, respeitando os termos da plataforma.
- **Cookies no Render:** exporte os cookies do youtube.com com a extensão "Get cookies.txt LOCALLY", de preferência usando uma conta secundária. No serviço, abra **Environment → Secret Files** e crie o arquivo `cookies.txt` com esse conteúdo. Depois adicione a variável `YTDLP_COOKIES_FILE=/etc/secrets/cookies.txt`. O app trabalha com uma cópia do arquivo, porque os arquivos secretos do Render são somente leitura.
- O yt-dlp usa o Node.js (`YTDLP_JS_RUNTIMES=node`) para resolver os desafios JavaScript do YouTube. Sem isso, muitos vídeos falham ou ficam sem formatos.
- As falhas do yt-dlp são registradas nos logs do servidor com as últimas linhas da mensagem original, o que facilita o diagnóstico.
- O estado das conversões fica em memória, então rode **uma instância** por disco. Para escalar horizontalmente, troque `JobManager` por uma fila com Redis (por exemplo, BullMQ) e use armazenamento compartilhado.
- Ajuste `MAX_CONCURRENT_JOBS` à CPU disponível. Converter para MP3 e unir 1080p consomem processador e banda.

## Configuração

Todas as opções estão em [`.env.example`](.env.example). As principais:

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `MAX_CONCURRENT_JOBS` | `2` | Conversões simultâneas |
| `MAX_DURATION_SECONDS` | `10800` | Duração máxima do vídeo (3 h) |
| `MAX_FILESIZE_MB` | `2048` | Tamanho máximo do arquivo |
| `FILE_TTL_MINUTES` | `30` | Tempo até os arquivos serem apagados |
| `RATE_LIMIT_CONVERT` | `15` | Conversões por IP por janela de 15 min |
| `YTDLP_COOKIES_FILE` | — | Cookies opcionais para o yt-dlp |
