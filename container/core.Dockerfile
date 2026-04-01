FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    docker.io \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
