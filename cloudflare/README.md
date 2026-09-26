# Cloudflare Workers 版（免费、永不休眠）

这是同一套吐槽铺的 Cloudflare 版本。功能完全一致：发吐槽、贴墙、碎纸机、同感、接话、举报、后台数据看板与内容管理、sitemap / RSS / 分享页，一个都不少。

和根目录那套 Node 版的区别只有运行环境：

| | Node 版（server.js） | Cloudflare 版（本目录） |
| --- | --- | --- |
| 运行方式 | 常驻进程，自己找服务器 | Cloudflare 边缘节点，按请求执行 |
| 数据库 | 本地 SQLite 文件 | Cloudflare D1（同样是 SQLite） |
| 静态资源 | 从磁盘读 | 构建时打包进 Worker |
| 花钱 | 要一台服务器 | 免费额度内不花钱 |
| 适合 | 想要完全自己掌控 / 国内访问 | 不想管服务器 / 预算为零 |

**两套共用 `public/render.js`**，也就是说便利贴长什么样、SEO 标签怎么给，两边是同一份代码，不会出现「改了一边忘了另一边」。

---

## 免费额度（够用很久）

| 项目 | 免费额度 |
| --- | --- |
| 请求数 | 每天 10 万次 |
| 每次执行的 CPU | 10 毫秒（本 Worker 只用 1～3 毫秒） |
| D1 数据库读取 | 每天 500 万行 |
| D1 数据库写入 | 每天 10 万行 |
| D1 存储 | 5 GB |

---

## 用命令行部署

```bash
cd cloudflare

# 1. 登录 Cloudflare（会打开浏览器授权）
npx wrangler login

# 2. 建数据库，把返回的 database_id 填进 wrangler.toml
npx wrangler d1 create tucao-pu

# 3. 设置两个密钥（会提示你输入）
npx wrangler secret put ADMIN_PASSWORD    # 后台密码，设长一点
npx wrangler secret put IP_SALT           # 随便一串 32 位随机字符

# 4. 部署（会自动先跑 build.mjs）
npx wrangler deploy
```

部署完终端会给出网址，形如 `https://tucao-pu.你的子域.workers.dev`。
登录 `网址/admin`，密码就是第 3 步设的 `ADMIN_PASSWORD`。

数据库不用手动建表 —— 第一次访问时 Worker 会自动建好表结构，并放一条站长的欢迎帖。

### 本地调试

```bash
cd cloudflare
npx wrangler dev          # 本地跑，自带一个本地 D1
```

---

## 关于域名

免费的 `*.workers.dev` 域名**在国内访问不稳定**，如果你的读者主要在国内，建议绑一个自己的域名：

1. 在 Cloudflare 里添加你的域名（免费套餐即可）
2. wrangler.toml 里加：
   ```toml
   routes = [{ pattern = "你的域名", custom_domain = true }]
   ```
3. 再 `npx wrangler deploy`

国内访问要求更高的话，本地目录那套 Node 版更适合放到香港或日本的服务器上。

---

## 目录说明

| 文件 | 作用 |
| --- | --- |
| `worker.js` | Worker 源码（服务端逻辑、接口、后台） |
| `build.mjs` | 构建脚本：把 `../public/*` 和 worker.js 打成一个文件 |
| `wrangler.toml` | Cloudflare 部署配置 |
| `dist/worker.js` | 构建产物，部署的就是它 |
