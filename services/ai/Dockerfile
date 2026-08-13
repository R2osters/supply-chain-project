# syntax=docker/dockerfile:1
#
# The AI service is self-contained — it depends on nothing outside services/ai — so it is
# built from its own directory.

FROM python:3.12-slim-bookworm AS runtime
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# Python 3.12 rather than 3.13: OR-Tools, scipy and scikit-learn all ship prebuilt wheels for
# 3.12, and falling back to source builds would turn a 2-minute image build into a 20-minute one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY pytest.ini .
RUN mkdir -p models_store

RUN useradd --create-home --uid 10001 scip && chown -R scip:scip /app
USER scip

EXPOSE 8000

HEALTHCHECK --interval=20s --timeout=4s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

# One worker: the optimisers are CPU-bound and already release the GIL inside OR-Tools and
# numpy. Scale with container replicas rather than in-process workers, so one runaway solve
# cannot starve the others in the same process.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
