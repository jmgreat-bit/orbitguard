import { defineConfig, loadEnv } from 'vite';
import { createApiMiddleware } from './server/api.js';

// Server-only variables (GEMINI_API_KEY, GEMINI_MODEL, NASA_API_KEY) are read here,
// in Node, and never bundled into the browser code.
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const api = {
        name: 'orbitguard-api',
        configureServer(server) { server.middlewares.use(createApiMiddleware(env)); },
        configurePreviewServer(server) { server.middlewares.use(createApiMiddleware(env)); },
    };
    return {
        plugins: [api],
        server: { port: 5173, open: true },
        build: { chunkSizeWarningLimit: 900 },
        test: { environment: 'node', include: ['test/**/*.test.js'] },
    };
});
