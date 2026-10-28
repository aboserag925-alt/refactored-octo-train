FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV WORKSPACE_ROOT=/app/workspace
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/workspace && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "healthcheck.js"]
CMD ["npm", "start"]
