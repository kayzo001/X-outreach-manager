# One image, two roles: web (default CMD) and worker (`npm run worker`).
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-client && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --ignore-scripts && npx prisma generate

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build --chown=node:node /app ./
RUN npm prune --omit=dev --ignore-scripts && npx prisma generate && chown -R node:node /app/node_modules/.prisma
USER node
EXPOSE 3000
# Web: apply migrations (safe/idempotent), create the owner login on first boot only, then serve.
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx prisma/seed.ts --if-empty && npm run start"]
