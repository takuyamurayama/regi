FROM python:3.11-slim-bookworm@sha256:2333bd330d12de02514770b3585cad313644316047cdee24a7acfdece6de6efb AS python
WORKDIR /build
COPY forecast/requirements.txt ./
RUN python -m venv /opt/forecast \
    && /opt/forecast/bin/pip install --no-cache-dir -r requirements.txt

FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
RUN npm ci
COPY . .
RUN npx prisma generate --schema apps/api/prisma/schema.prisma && npm run build

FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       openssl fonts-noto-cjk libgomp1 libbz2-1.0 libexpat1 libffi8 liblzma5 libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=python /usr/local /usr/local
COPY --from=python /opt/forecast /opt/forecast
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/core/dist ./packages/core/dist
# Maintenance commands use tsx and import the same API/core sources as the builder.
COPY --from=builder /app/apps/api/src ./apps/api/src
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder /app/packages/core/src ./packages/core/src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/forecast ./forecast
ENV NODE_ENV=production \
    JAPANESE_FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc \
    PYTHON_EXECUTABLE=/opt/forecast/bin/python
RUN mkdir -p /app/docs /app/.context && chown -R node:node /app/docs /app/.context
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/apps/api/src/main.js"]
