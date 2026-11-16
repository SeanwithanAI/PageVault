# PageVault image. GitHub builds and publishes it automatically on every update:
#   ghcr.io/seanwithanai/pagevault:latest
# You don't need to build it yourself. See docker-compose.yml or truenas-app.yaml.
FROM python:3.12-alpine

LABEL org.opencontainers.image.title="PageVault" \
      org.opencontainers.image.description="A private app portal for your own HTML apps" \
      org.opencontainers.image.source="https://github.com/SeanwithanAI/PageVault" \
      org.opencontainers.image.licenses="NOASSERTION"

WORKDIR /app
COPY server.py ./
COPY static ./static

# 568 is the TrueNAS "apps" user. Owning the empty /data and /apps folders means
# plain Docker named volumes start out writable with no extra setup.
RUN mkdir -p /data /apps && chown 568:568 /data /apps

ENV DATA_DIR=/data APPS_DIR=/apps PORT=8080 PYTHONDONTWRITEBYTECODE=1
VOLUME ["/data", "/apps"]
EXPOSE 8080
USER 568:568

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz')"

CMD ["python", "-u", "/app/server.py"]
