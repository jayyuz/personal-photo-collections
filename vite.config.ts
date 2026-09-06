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

// 只在沙箱/远程预览环境里覆写 HMR 与 host 校验。
// 本地 `npm run dev` 时 SANDBOX_ID 为空，如果仍然下发这段配置，
// 浏览器会去连 wss://3000-undefined.ap-guangzhou.tencentags.com:443，
// 连不上后 Vite client 会触发 location.reload()，表现为页面每 3~5 秒自动刷新一次。
const isSandbox = Boolean(sandboxId);

export default defineConfig({
  base,
  plugins: [optionalJsxSourcePlugin(), react(), checker({ typescript: false }), uploadPlugin()],
  server: {
    port: 8000,
    host: '0.0.0.0',
    ...(isSandbox
      ? {
          allowedHosts: [sandboxId!, '.app.qpilot.woa.com', '.ap-guangzhou.tencentags.com'],
          hmr: {
            protocol: 'wss',
            clientPort: 443,
            host: `3000-${sandboxId}.ap-guangzhou.tencentags.com`,
          },
        }
      : {}),
  },
});
