FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PROJECT_ID=live-api-webrtc-testing \
    PORT=8080

WORKDIR /app

# Install dependencies first so code changes don't invalidate this layer.
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend backend
COPY frontend frontend

RUN useradd --system --uid 10001 app
USER app

# main.py imports its sibling modules by name.
WORKDIR /app/backend
EXPOSE 8080

# `exec` makes python PID 1, so it receives Cloud Run's SIGTERM and shuts down
# cleanly instead of being killed when the grace period ends. Outside Cloud Run
# the server binds 127.0.0.1, which `docker run -p` can't reach; publish the
# port as `-p 127.0.0.1:8080:8080` to keep it off the network.
CMD exec python main.py --project_id="$PROJECT_ID" --host=0.0.0.0
