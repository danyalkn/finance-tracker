# Fly.io / container image for finance-tracker.
# Storage is Supabase/Postgres in production (set DATABASE_URL), so the
# container itself is stateless — no persistent disk needed.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install only production deps (express + pg)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY . .

EXPOSE 3000
CMD ["npm", "start"]
