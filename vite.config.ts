import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { resolve } from 'node:path';

const WEB_ROOT = resolve(__dirname, 'web');

export default defineConfig(({ command }) => ({
  root: WEB_ROOT,
  publicDir: false,
  plugins: [solid()],
  resolve: {
    alias: {
      '~': resolve(WEB_ROOT, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/auth': 'http://127.0.0.1:8787',
      '/s': 'http://127.0.0.1:8787',
      '/dav': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: resolve(__dirname, 'public'),
    emptyOutDir: false,
    assetsDir: 'assets',
    cssCodeSplit: true,
    sourcemap: command === 'serve',
    rollupOptions: {
      input: {
        dashboard: resolve(WEB_ROOT, 'dashboard.html'),
        login: resolve(WEB_ROOT, 'login.html'),
        share: resolve(WEB_ROOT, 'share.html'),
        guest: resolve(WEB_ROOT, 'guest.html'),
        notfound: resolve(WEB_ROOT, '404.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
