import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.VITE_API_PROXY_TARGET || "http://localhost:80";

export default defineConfig({
  plugins: [react()],
  base: "/tool/",
  build: {
    outDir: "../public/tool",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/etl": backend,
      "/auth": backend,
      "/user": backend,
    },
  },
});
