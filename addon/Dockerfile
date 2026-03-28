ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js 20 and build tools for native addons (serialport, etc.)
RUN apk add --no-cache nodejs npm python3 make g++ linux-headers udev

WORKDIR /app

# Copy package files first for layer caching
COPY package.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/

# Healthcheck — verify WebSocket port is listening
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD nc -z localhost ${WEBSOCKET_PORT:-8756} || exit 1

CMD ["node", "src/server.js"]
