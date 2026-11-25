FROM registry:2.8.3 AS registry
FROM gcr.io/go-containerregistry/crane:v0.20.3 AS crane

FROM node:24-bookworm-slim AS encore-build
ARG TARGETARCH
WORKDIR /app/backend
ENV ENCORE_INSTALL=/opt/encore
ENV PATH="/opt/encore/bin:${PATH}"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git \
    && curl -fsSL https://encore.dev/install.sh -o /tmp/install-encore.sh \
    && bash /tmp/install-encore.sh 1.58.10
COPY --from=registry /bin/registry /usr/local/bin/registry
COPY --from=crane /ko-app/crane /usr/local/bin/crane
COPY backend/ ./
COPY deploy/build-encore.sh /app/build-encore.sh
RUN bash /app/build-encore.sh "${TARGETARCH:-amd64}"

FROM node:24-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_BROWSERS_PATH=/opt/cowork-browsers
COPY . .
COPY --from=encore-build /out/ /app/encore/
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates gosu \
    && npm ci && npm run build && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/backend/.cowork \
    && chown -R node:node /app/backend/.cowork /app/.next
ENV NODE_ENV=production COWORK_SECURE_COOKIE=1
EXPOSE 4400
HEALTHCHECK --interval=20s --timeout=5s --start-period=25s CMD node -e "fetch('http://127.0.0.1:4400/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["/bin/bash", "/app/deploy/start.sh"]
