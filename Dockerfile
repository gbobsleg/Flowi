FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN chmod +x /app/scripts/docker-entrypoint.sh && sed -i 's/\r$//' /app/scripts/docker-entrypoint.sh
EXPOSE 3000
CMD ["/app/scripts/docker-entrypoint.sh"]
