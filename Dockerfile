FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY data ./data

ENV SAMPLE_PATH=/srv/data/sample.json \
    PORT=8000

EXPOSE 8000

# 健康检查：直接请求 /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:%s/healthz'%os.environ.get('PORT','8000'))" || exit 1

CMD ["sh", "-c", "gunicorn --chdir /srv/app --bind 0.0.0.0:${PORT} --workers 2 --timeout 60 app:app"]
