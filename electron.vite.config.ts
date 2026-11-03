import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const coreAlias = { '@core': resolve(__dirname, 'src/core') };

export default defineConfig({
  main: {
    resolve: { alias: coreAlias },
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } }
  },
  preload: {
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: coreAlias },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          // The visible UI.
          index: resolve(__dirname, 'src/renderer/index.html'),
          // A hidden window that owns microphone capture and speaker playback.
          // RTP sockets stay in the main process, so this one needs no Node access.
          media: resolve(__dirname, 'src/renderer/media.html')
        }
      }
    }
  }
});
