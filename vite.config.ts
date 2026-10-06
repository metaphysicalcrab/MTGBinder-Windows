import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    // One local bundle served from localhost; splitting it buys nothing.
    chunkSizeWarningLimit: 1024,
  },
  server: {
    port: 5173,
    // The API server's port: the one it listens on (PORT, else 4321). The same-origin guard needs the page's own
    // Host, so changeOrigin must stay false (the string shorthand turns it on, sending the target's Host instead).
    // xfwd adds the browser's address to X-Forwarded-For: with `vite --host`, a phone's requests reach the server
    // from this computer, and that address is what tells the guard they're a phone's.
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.PORT ?? 4321}`, changeOrigin: false, xfwd: true },
    },
  },
})
