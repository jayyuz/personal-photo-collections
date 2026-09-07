/**
 * 起 vite dev + 无头 Chrome 打开 smoke.html，等页面把结果 POST 回来。
 *
 *   npm run smoke
 *   npm run smoke -- sample=14
 *   npm run smoke -- titles=郁金香,虞美人
 *
 * 需要本机有 Google Chrome。权重首次会从 Hugging Face 下载，之后走浏览器缓存。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TIMEOUT_MS = 15 * 60 * 1000;
const VITE_PORT = 8000;
const REPORT_PORT = 8931;

const extra = process.argv[2] ? `&${process.argv[2]}` : '';
const reportUrl = `http://127.0.0.1:${REPORT_PORT}/r`;
const pageUrl = `http://localhost:${VITE_PORT}/smoke.html?report=${encodeURIComponent(reportUrl)}${extra}`;

function killTree(child) {
  if (!child.pid) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
}

const result = new Promise(resolve => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end('ok');
      if (req.method === 'POST') {
        server.close();
        resolve(body);
      }
    });
  });
  server.listen(REPORT_PORT, '127.0.0.1');
});

const vite = spawn('npx', ['vite', '--port', String(VITE_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => {
  const fail = setTimeout(() => reject(new Error('vite 没在 20s 内就绪')), 20_000);
  const onData = d => {
    const s = String(d);
    if (s.includes('ready in') || s.includes('Local:')) {
      clearTimeout(fail);
      resolve();
    }
  };
  vite.stdout.on('data', onData);
  vite.stderr.on('data', onData);
  vite.on('exit', code => {
    if (code) reject(new Error(`vite 退出 ${code}`));
  });
});

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  `--user-data-dir=/tmp/smoke-chrome-profile`,
  '--enable-logging=stderr',
  '--v=0',
  pageUrl,
], { stdio: ['ignore', 'ignore', 'pipe'] });

chrome.stderr.on('data', d => {
  const s = String(d);
  if (/ERROR|Uncaught|Failed/i.test(s) && !/CVDisplayLink|Crashpad|DEPRECATED_ENDPOINT/.test(s)) {
    process.stderr.write(s);
  }
});

const timeout = new Promise(r => setTimeout(() => r('TIMEOUT: 页面没在 15 分钟内回报'), TIMEOUT_MS));
const out = await Promise.race([result, timeout]);

console.log('\n================ 结果 ================\n');
console.log(out);

killTree(chrome);
killTree(vite);
process.exit(0);
