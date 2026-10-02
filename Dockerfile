FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl fonts-noto-cjk python3 python3-venv libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
RUN npm ci
COPY . .
RUN python3 -m venv /opt/forecast && /opt/forecast/bin/pip install --no-cache-dir -r forecast/requirements.txt
RUN npx prisma generate --schema apps/api/prisma/schema.prisma && npm run build
ENV NODE_ENV=production JAPANESE_FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc PYTHON_EXECUTABLE=/opt/forecast/bin/python
RUN mkdir -p /app/docs /app/.context && chown -R node:node /app/docs /app/.context
USER node
EXPOSE 3000
CMD ["node","apps/api/dist/apps/api/src/main.js"]
