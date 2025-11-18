ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app

# Install dependencies
# CACHE_BUST: 2025-11-18-12:05 - Force rebuild to apply CYPRESS_INSTALL_BINARY fix
COPY package*.json ./
# First install ALL deps (including devDeps needed for build like TypeScript, Vite)
# but skip Cypress binary download
RUN CYPRESS_INSTALL_BINARY=0 npm ci --no-audit --no-fund
# IMPORTANT: déclarer l'ARG pour l'injecter au build
ARG VITE_API_BASE
ENV VITE_API_BASE=${VITE_API_BASE}
# Copy source and build
COPY . .
RUN npm run build
# After build, prune devDependencies to reduce image size
RUN npm prune --production


# Serve the built app

ENV PORT=5173
EXPOSE 5173
CMD ["sh", "-c", "npm run preview -- --host 0.0.0.0 --port ${PORT:-5173}"]
