FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 XDG_CACHE_HOME=/tmp/cache
WORKDIR /app
COPY apps/api/requirements.txt apps/api/container-constraints.txt requirements-engineering.txt ./
RUN pip install --no-cache-dir -c container-constraints.txt -r requirements.txt -r requirements-engineering.txt
COPY apps/api/ .
COPY packages/cad/ ./packages/cad/
COPY packages/costing/ ./packages/costing/
COPY packages/ai/ ./packages/ai/
USER 10001:10001
CMD ["uvicorn", "fabrication.main:app", "--host", "0.0.0.0", "--port", "8140", "--no-access-log"]
