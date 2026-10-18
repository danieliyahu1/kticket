import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const proxyTarget = process.env.VITE_API_PROXY ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1": proxyTarget,
      "/llms.txt": proxyTarget,
      "/openapi.json": proxyTarget,
      "/.well-known": proxyTarget,
      "/docs": proxyTarget,
      "/robots.txt": proxyTarget,
      "/sitemap.xml": proxyTarget,
    },
    allowedHosts: true,
  },
});
