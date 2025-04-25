FROM ghcr.io/swgoh-utils/swgoh-comlink:latest
ENV PORT=3000 ENABLE_DOCS=true
EXPOSE 3000
HEALTHCHECK --interval=30s CMD curl -f http://localhost:3000/readyz || exit 1
