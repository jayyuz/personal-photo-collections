import { createRequire } from 'node:module';
import react from '@vitejs/plugin-react';
import { defineConfig, type PluginOption } from 'vite';
import checker from 'vite-plugin-checker';
import { uploadPlugin } from './upload-plugin';

const sandboxId = process.env.SANDBOX_ID;

// GitHub Pages 部署时通过环境变量传入 base
const base = process.env.BASE_URL || '/';

function optionalJsxSourcePlugin(): PluginOption | null {
  try {
    const loaded = createRequire(import.meta.url)('@tencent/vite-plugin-add-jsx-source');
    const factory = loaded.default ?? loaded;
    return typeof factory === 'function' ? factory() : null;
  } catch {
    return null;
  }
}

export default defineConfig({
  base,
  plugins: [optionalJsxSourcePlugin(), react(), checker({ typescript: false }), uploadPlugin()],
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: [sandboxId, '.app.qpilot.woa.com', '.ap-guangzhou.tencentags.com'],
    hmr: { protocol: 'wss', clientPort: 443, host: `3000-${sandboxId}.ap-guangzhou.tencentags.com` },
  },
});
