import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: process.env.DASHBOARD_BASE_PATH ?? "/admin/",
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    proxy: {
      "/admin/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
