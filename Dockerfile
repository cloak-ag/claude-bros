# syntax = docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

# Install deps first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

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