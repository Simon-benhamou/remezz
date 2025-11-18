ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app

# Install dependencies
COPY package*.json ./
# Use flags to reduce external calls and speed up CI
# Skip Cypress binary download (not needed for production build)
RUN CYPRESS_INSTALL_BINARY=0 npm ci --no-audit --no-fund --omit=optional
# IMPORTANT: déclarer l'ARG pour l'injecter au build
ARG VITE_API_BASE
ENV VITE_API_BASE=${VITE_API_BASE}
# Copy source and build
COPY . .
RUN npm run build


# Serve the built app

ENV PORT=5173
EXPOSE 5173
CMD ["sh", "-c", "npm run preview -- --host 0.0.0.0 --port ${PORT:-5173}"]
