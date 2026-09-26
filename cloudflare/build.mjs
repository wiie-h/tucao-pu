/* ============================================================
   把渲染逻辑、静态资源和 Worker 源码打成一个文件，
   直接上传到 Cloudflare 就能跑。

   用法：node build.mjs
   产物：dist/worker.js
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');            // 项目根目录
const PUBLIC = path.join(ROOT, 'public');
const DIST = path.join(HERE, 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};
const TEXTY = ['.html', '.css', '.js', '.json', '.svg', '.txt'];

const assets = {};

function add(abs, key) {
  const ext = path.extname(key).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const buf = fs.readFileSync(abs);
  if (TEXTY.includes(ext)) assets[key] = { type, text: buf.toString('utf8') };
  else assets[key] = { type, b64: buf.toString('base64') };
}

for (const name of fs.readdirSync(PUBLIC)) {
  const abs = path.join(PUBLIC, name);
  if (fs.statSync(abs).isFile()) add(abs, name);
}

// 分享卡片用的缩略图在项目根目录
const preview = path.join(ROOT, 'preview.png');
if (fs.existsSync(preview)) add(preview, 'preview.png');

const renderSrc = fs.readFileSync(path.join(PUBLIC, 'render.js'), 'utf8');
const workerSrc = fs.readFileSync(path.join(HERE, 'worker.js'), 'utf8');

const escaper = (s) => s.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const buildId = Date.now().toString(36);

const bundle = [
  '// 构建产物：由 cloudflare/build.mjs 生成，请勿直接编辑',
  '// 来源：public/* + cloudflare/worker.js',
  'globalThis.ASSETS = ' + escaper(JSON.stringify(assets)) + ';',
  'globalThis.BUILD_ID = ' + JSON.stringify(buildId) + ';',
  '',
  escaper(renderSrc),
  ';',
  escaper(workerSrc),
  ''
].join('\n');

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'worker.js'), bundle, 'utf8');

console.log('构建完成  build=' + buildId);
console.log('  资源 ' + Object.keys(assets).length + ' 个');
console.log('  产物 ' + path.relative(ROOT, path.join(DIST, 'worker.js')) +
  '  ' + Math.round(Buffer.byteLength(bundle) / 1024) + ' KB');
