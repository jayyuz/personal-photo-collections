import vitePluginAddJsxSource from '@tencent/vite-plugin-add-jsx-source';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import checker from 'vite-plugin-checker';
import { uploadPlugin } from './upload-plugin';

const sandboxId = process.env.SANDBOX_ID;

// GitHub Pages 部署时通过环境变量传入 base
const base = process.env.BASE_URL || '/';

export default defineConfig({
  base,
  plugins: [vitePluginAddJsxSource(), react(), checker({ typescript: false }), uploadPlugin()],
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: [sandboxId, '.app.qpilot.woa.com', '.ap-guangzhou.tencentags.com'],
    hmr: { protocol: 'wss', clientPort: 443, host: `3000-${sandboxId}.ap-guangzhou.tencentags.com` },
  },
});
