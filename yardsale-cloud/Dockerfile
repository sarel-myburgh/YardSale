FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown -R node:node /app /data

USER node
ENV NODE_ENV=production
ENV YARDSALE_CLOUD_DATA_DIR=/data
ENV YARDSALE_CLOUD_RUNTIME_EXECUTE=false
EXPOSE 3010
CMD ["node", "--experimental-sqlite", "src/server.js"]
