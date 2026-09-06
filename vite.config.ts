import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
const target =
  "http://" +
  (process.env.ROBO_HOST ?? "127.0.0.1") +
  ":" +
  (process.env.ROBO_PORT ?? "8940");
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5178,
    strictPort: true,
    proxy: {
      "/api": target,
      "/rerun": target,
      "/proxy": target,
    },
  },
  build: { outDir: "dist" },
});
