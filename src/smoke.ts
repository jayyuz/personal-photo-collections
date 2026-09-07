/**
 * 在真实浏览器里跑 src/ml 的实际代码，核对主题判断。
 *
 * 本地：npm run smoke
 * 带抽样：npm run smoke -- sample=14
 * 指定标题：npm run smoke -- titles=郁金香,人像
 *
 * 结果会 POST 到 ?report= 指定的地址，供 scripts/smoke-run.mjs 收集。
 * 这个文件不进主应用打包，只有 smoke.html 引用它。
 */
import { embedImage } from './ml/clip';
import { classifyThemes, pickTags } from './ml/tagging';

const out = document.getElementById('out')!;
const params = new URLSearchParams(location.search);
const report = params.get('report');
const lines: string[] = [];
const say = (s: string) => {
  lines.push(s);
  out.textContent = lines.join('\n');
};
const progress = (m: string) => {
  out.textContent = `${lines.join('\n')}\n${m}`;
};

const DEFAULT_TITLES = ['郁金香', '虞美人', '鲁冰花', '向阳', '热烈', '春风', '巨好看'];

async function main() {
  const photos: { title: string; src: string }[] = await (await fetch('/photos.json')).json();
  const titles = (params.get('titles') ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
  const named = titles.length ? titles : DEFAULT_TITLES;
  const sample = Number(params.get('sample') || 0);
  const targets = sample
    ? photos.filter(p => !named.includes(p.title)).filter((_, i) => i % 7 === 0).slice(0, sample)
    : photos.filter(p => named.includes(p.title));

  say(`共 ${targets.length} 张`);
  for (const p of targets) {
    const vec = await embedImage(p.src, progress);
    const scored = await classifyThemes(vec, progress);
    const top = scored.slice(0, 3).map(s => `${s.label} ${(s.prob * 100).toFixed(1)}%`).join('   ');
    say(`${p.title}\t→\t${top}\t[采用: ${pickTags(scored).join(',') || '无'}]`);
  }
}

main()
  .then(() => say('DONE'))
  .catch(e => say(`ERROR ${e instanceof Error ? e.message : String(e)}`))
  .finally(() => {
    if (report) void fetch(report, { method: 'POST', body: lines.join('\n') });
  });
