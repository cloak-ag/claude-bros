# syntax = docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

# Install deps first (cached layer)
COPY package*.json ./
# --include=optional so the pg driver is present when DATABASE_URL is set
RUN npm ci --omit=dev --include=optional 2>/dev/null || npm install --omit=dev --include=optional

# Copy source
COPY bin/ ./bin/
COPY server/ ./server/
COPY templates/ ./templates/

# Non-root user
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app
USER app

# Cloud Run injects PORT (default 8080)
ENV PORT=8080
EXPOSE 8080

# Start the relay — token from Secret Manager or env
CMD ["node", "bin/claude-bros.js", "serve", "--host", "0.0.0.0"]