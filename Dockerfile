# Optional: build your own image instead of mounting the code folder.
#   docker build -t pagevault .
#   docker run -d -p 8090:8080 -v /path/to/data:/data -v /path/to/apps:/apps pagevault
FROM python:3.12-alpine
WORKDIR /app
COPY server.py ./
COPY static ./static
ENV DATA_DIR=/data APPS_DIR=/apps PORT=8080
VOLUME ["/data", "/apps"]
EXPOSE 8080
USER 568:568
CMD ["python", "-u", "/app/server.py"]
