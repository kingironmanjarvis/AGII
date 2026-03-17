import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_API_URL': JSON.stringify(process.env.VITE_API_URL || 'https://agii-v10-backend.onrender.com')
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: { manualChunks: undefined }
    }
  }
})
