# Noctis keeper-relayer (+ ops-monitor via compose command override)
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache curl

COPY package.json ./
# No package-lock in this package — install from package.json
RUN npm install --omit=dev && npm install tsx@4.21.0 --no-save

COPY tsconfig.docker.json ./tsconfig.json
COPY src ./src

RUN mkdir -p /app/logs \
  && addgroup -g 1001 -S keeper \
  && adduser -S -D -H -u 1001 -h /app -s /sbin/nologin -G keeper keeper \
  && chown -R keeper:keeper /app

USER keeper

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3001/api/relay/health || exit 1

CMD ["npx", "tsx", "src/keeper-relayer.ts"]
