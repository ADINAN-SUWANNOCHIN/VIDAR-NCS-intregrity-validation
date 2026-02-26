# ============================================================
# Stage 1 — Build (TypeScript → JavaScript)
# ============================================================
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ============================================================
# Stage 2 — Production image (lean, no dev tools)
# ============================================================
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# Install production deps only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output and rule configs
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/rules ./rules

# Reports directory (will be mounted as emptyDir in k8s)
RUN mkdir -p /app/reports

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
