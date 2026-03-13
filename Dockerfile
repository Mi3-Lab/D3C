FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV DATASETS_ROOT=/var/lib/d3c/datasets
ENV AUTH_STATE_PATH=/var/lib/d3c/auth/auth_state.json
ENV PARQUET_PYTHON_BIN=python3
ENV FFMPEG_BIN=ffmpeg

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY client-mobile ./client-mobile
COPY dashboard ./dashboard
COPY docs ./docs
COPY fleet-server ./fleet-server
COPY README.md ./README.md

RUN mkdir -p /var/lib/d3c/datasets /var/lib/d3c/auth \
  && pip3 install --no-cache-dir pyarrow

EXPOSE 3000

CMD ["node", "fleet-server/index.js", "--port", "3000", "--host", "0.0.0.0"]
