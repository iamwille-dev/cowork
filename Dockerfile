FROM node:24-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_BROWSERS_PATH=/opt/cowork-browsers
COPY . .
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && npm ci && npm run build && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/backend/.cowork \
    && chown -R node:node /app/backend/.cowork /app/.next
ENV NODE_ENV=production COWORK_SECURE_COOKIE=1
USER node
EXPOSE 4400
HEALTHCHECK --interval=20s --timeout=5s --start-period=25s CMD node -e "fetch('http://127.0.0.1:4400/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["/bin/bash", "/app/deploy/start.sh"]
