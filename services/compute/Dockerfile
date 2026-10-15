FROM oven/bun:1.4.0-debian

RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates tar gzip \
	&& rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://lane.lukeed.com | LANE_VERSION=v0.1.0 LANE_INSTALL=/usr/local/bin sh

WORKDIR /app
COPY dist/runner.js ./runner.js
RUN mkdir -p /workspace

EXPOSE 8080
CMD ["bun", "--no-env-file", "runner.js"]
