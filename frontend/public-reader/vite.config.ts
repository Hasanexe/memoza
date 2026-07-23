import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    rollupOptions: {
      input: 'src/main.ts',
      output: {
        entryFileNames: 'reader.js',
        assetFileNames: 'reader.[ext]',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
