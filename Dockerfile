FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Primero solo las dependencias: Docker reutiliza esta capa si package.json no cambió
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .

# Render inyecta PORT (10000 por defecto); en local usa 7000
ENV PORT=7000
EXPOSE 7000

USER node
CMD ["node", "index.js"]
