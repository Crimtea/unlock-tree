import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages 子仓库路径：https://crimtea.github.io/unlock-tree/
  base: '/unlock-tree/',
  plugins: [react()],
})
