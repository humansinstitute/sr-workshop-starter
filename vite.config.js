import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
    allowedHosts: true,
  },
  resolve: {
    alias: {
      buffer: 'buffer',
    },
  },
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['buffer'],
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        superbased: resolve(__dirname, 'src/superbased-bundle.js'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'superbased') {
            return 'js/superbased-sdk.js';
          }
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
});
