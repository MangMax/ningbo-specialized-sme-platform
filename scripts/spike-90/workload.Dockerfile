FROM ghcr.io/astral-sh/uv:0.9.18 AS uv
FROM python:3.12.13-slim-bookworm
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_CACHE_DIR=/opt/uv-cache PYTHONDONTWRITEBYTECODE=1 PYTHONUTF8=1
COPY workload.py /opt/spike/workload.py
RUN uv run /opt/spike/workload.py --help >/dev/null
ENTRYPOINT ["uv", "run", "--offline", "/opt/spike/workload.py"]
