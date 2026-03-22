FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npx prisma generate

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules         ./node_modules
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/src                  ./src
COPY --from=builder /app/prisma               ./prisma
COPY package*.json ./

RUN mkdir -p uploads/avatars

EXPOSE 3001

# Push schema + seed (idempotent) then start
CMD ["sh", "-c", "npx prisma db push && node src/index.js"]
