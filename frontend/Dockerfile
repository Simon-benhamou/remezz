FROM node:20-slim
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci
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
