# syntax=docker/dockerfile:1
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-alpine
ENV NODE_ENV=production CONFIG_DIR=/config
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Unraid's nobody:users. /config must be writable by this user.
RUN mkdir -p /config && chown 99:100 /config
USER 99:100
VOLUME /config
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["daemon"]
