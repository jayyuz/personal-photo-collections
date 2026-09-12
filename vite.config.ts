import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * WebXR 只在「安全上下文」里可用 —— HTTPS 或 localhost。
 * 头显用 http://192.168.x.x:8000 这种局域网地址打开时 navigator.xr 根本不存在，
 * VR 按钮不会出现。`npm run dev:https` 挂上自签证书，头显里信任一次即可。
 *
 * 证书只存在本地（.cert/，已 gitignore），不引第三方依赖。
 */
function optionalHttps(): { cert: Buffer; key: Buffer } | undefined {
  if (process.env.HTTPS !== '1') return undefined;
  const dir  = join(__dirname, '.cert');
  const cert = join(dir, 'cert.pem');
  const key  = join(dir, 'key.pem');
  if (!existsSync(cert) || !existsSync(key)) {
    console.log('[vite] 首次生成自签证书（macOS/Linux 需要 openssl）…');
    mkdirSync(dir, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '365',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
  }
  return { cert: readFileSync(cert), key: readFileSync(key) };
}

// 只在沙箱/远程预览环境里覆写 HMR 与 host 校验。
// 本地 `npm run dev` 时 SANDBOX_ID 为空，如果仍然下发这段配置，
// 浏览器会去连 wss://3000-undefined.ap-guangzhou.tencentags.com:443，
// 连不上后 Vite client 会触发 location.reload()，表现为页面每 3~5 秒自动刷新一次。
const isSandbox = Boolean(sandboxId);

export default defineConfig({
  base,
  plugins: [optionalJsxSourcePlugin(), optionalHttps(), react(), checker({ typescript: false }), uploadPlugin()],
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  server: {
    port: 8000,
    // 头显要通过局域网 IP 访问；'::' 同时监听 IPv4 / IPv6
    host: true,
    strictPort: true,
    https: optionalHttps(),
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
