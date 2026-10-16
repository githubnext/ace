# The Sandbox SDK's Cloudflare adapter talks to this image's control plane on port 3000.
FROM docker.io/cloudflare/sandbox:0.12.9

RUN curl -fsSL https://lane.lukeed.com | LANE_VERSION=v0.1.0 LANE_INSTALL=/usr/local/bin sh

WORKDIR /app
COPY dist/runner.js ./runner.js
RUN mkdir -p /workspace
