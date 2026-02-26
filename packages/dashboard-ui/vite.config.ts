import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/dashboard/",
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    proxy: {
      "/dashboard/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
