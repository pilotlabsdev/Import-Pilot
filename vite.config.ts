import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { reactRouter } from "@react-router/dev/vite";

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
  server: {
    host: true,
    allowedHosts: true,
  },
  resolve: {
    dedupe: ['react', 'react-dom', 'react-router'],
  },
  optimizeDeps: {
    exclude: ['@shopify/shopify-app-react-router/server'],
  },
});