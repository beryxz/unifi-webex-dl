FROM node:16-alpine

WORKDIR /app

RUN chown 1000:1000 /app

USER 1000:1000

COPY package*.json ./

RUN npm ci --production

COPY . .

VOLUME /app/config
VOLUME /app/downloads

ENV CONFIG_PATH=/app/config/config.json
CMD ["node", "app.js"]
