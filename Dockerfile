FROM python:3.11-slim

# OpenCV headless runtime deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY greenscreen.py server.py ./
COPY static/ static/

CMD uvicorn server:app --host 0.0.0.0 --port ${PORT:-8000}
