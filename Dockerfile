# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY . .

# Build the app
RUN npm run build

# Production stage
FROM node:22-alpine AS production

WORKDIR /app

# Copy built app
COPY --from=builder /app/build ./build
COPY --from=builder /app/package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Environment variables
ENV NODE_ENV=production
ENV MAM_ID=
ENV MAM_UID=
ENV BOOKS_DIR=/books
ENV QB_URL=http://qbittorrent:8080
ENV QB_USERNAME=admin
ENV QB_PASSWORD=
ENV QB_CATEGORY=books
ENV QB_SAVE_PATH=
ENV PORT=3000
ENV HOST=0.0.0.0
# Allow cover image uploads (adapter-node defaults to 512K)
ENV BODY_SIZE_LIMIT=10M

EXPOSE 3000

CMD ["node", "build"]
