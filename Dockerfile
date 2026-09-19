FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/scripts ./scripts
RUN chmod +x /app/scripts/docker-entrypoint.sh && sed -i 's/\r$//' /app/scripts/docker-entrypoint.sh
EXPOSE 3000
CMD ["/app/scripts/docker-entrypoint.sh"]
