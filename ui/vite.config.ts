import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "node:url"

// Dev proxy: `npm run dev` talks to a local backend-local on :8787 so the UI
// can be developed against real data without CORS ceremony. In production the
// built SPA is served by backend-local itself (same origin).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
})
