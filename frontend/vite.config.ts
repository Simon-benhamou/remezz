import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'lucide-react': fileURLToPath(new URL('./src/stubs/lucide-react.tsx', import.meta.url)),
    },
  },
  server: { host: true},
   preview: {
     allowedHosts: ['quantai.up.railway.app']
   },
  test: {
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
    globals: true,
    coverage: {
      reporter: ['text', 'json'],
    },
  }
});
