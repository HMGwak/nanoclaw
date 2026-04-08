FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    docker.io \
    ca-certificates \
    git \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Create a Linux-native Python venv for the quality loop engine
ENV QUALITY_LOOP_VENV=/opt/nanoclaw-venv
RUN python3 -m venv $QUALITY_LOOP_VENV \
    && $QUALITY_LOOP_VENV/bin/pip install --quiet --no-cache-dir \
       openai>=1.30.0 requests>=2.31.0 pyyaml pydantic
ENV QUALITY_LOOP_PYTHON=$QUALITY_LOOP_VENV/bin/python

WORKDIR /workspace
