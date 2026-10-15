FROM mcr.microsoft.com/playwright:v1.64.0
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production
CMD ["npx", "tsx", "server.ts"]