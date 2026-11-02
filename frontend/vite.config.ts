/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.HOMEBAR_BACKEND ?? "http://localhost:8080";

export default defineConfig({
  base: "/",
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/uploads": { target: backend, changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/uploads": { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    cssCodeSplit: true,
    assetsInlineLimit: 2048,
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
