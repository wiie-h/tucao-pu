# 吐槽铺

一个可以匿名吐槽的网站：**前台**给别人写和看，**后台**给你看数据和管理内容。

零第三方依赖，只用 Node 自带的能力，数据库是内置的 SQLite —— 一台最低配的服务器就能跑，也不存在「依赖哪天坏了」「账单按量涨」的问题。

---

## 一、本地跑起来

需要 Node 22.5 以上（推荐 Node 24）。不需要 `npm install`。

```bash
cd outputs

# Windows PowerShell
$env:ADMIN_PASSWORD="你的后台密码"; node server.js

# macOS / Linux
ADMIN_PASSWORD="你的后台密码" node server.js
```

然后打开：

- 前台：http://localhost:8899
- 后台：http://localhost:8899/admin

没设 `ADMIN_PASSWORD` 也能启动 —— 它会随机生成一个密码打印在终端里，但那只是方便你试，正式上线一定要自己设。

---

## 二、这台服务器上有什么

### 前台（给别人用）

| 能力 | 说明 |
| --- | --- |
| 发吐槽 | 挑心情 + 最多 3 个标签 + 匿名昵称，不用注册 |
| 贴到墙上 | 立刻公开，署名「我的」标记，自己可以随时删 |
| 碎掉它 | 私密销毁。**内容一个字都不上传**，服务器只收到「碎掉了几个字」这个数字 |
| 同感 / 接一句 | 互动，每台设备各算一次，防止刷 |
| 吐槽墙 | 按心情筛选、最新/最热排序、关键词搜索、只看自己的、点标签当筛选 |
| 分享 | 每条吐槽有独立链接 `/t/xxxx`，可复制分享，微信/QQ/Twitter 都能出卡片 |
| 举报 | 每张便利贴右上角 🚩，会进后台的待处理队列 |

### 后台（给你用）

打开 `/admin`，输入 `ADMIN_PASSWORD` 进入。

**数据看板**

- 当前在线人数（实时）、最近 5 分钟 / 1 小时的浏览量
- 今日与累计的：浏览量 PV、独立访客 UV、新增吐槽、碎掉数量、同感数、回复数
- 近 24 小时访问曲线、7 / 14 / 30 天趋势（PV / UV / 新增吐槽三条对比）
- 心情分布（大家都在气什么）、访客来源、设备、浏览器
- 被同感最多的吐槽 TOP
- 实时访问流：谁在什么时候看了哪个页面、用什么设备、从哪来的

**内容管理**

- 全部内容列表，可按「待审 / 被举报 / 已隐藏」筛选，可搜索
- 每条可以：隐藏、恢复、置顶、删除、**封禁来源**（隐藏内容并禁止该来源继续发言）
- 举报队列：查看原帖、隐藏原帖、标记已处理
- 一键导出 CSV（Excel 能直接打开）

**关于统计口径**：统计只记真人访问，爬虫（百度、Google、必应等）不计入，也不会因为你刷新后台而虚增。数据保留 180 天，可用 `RETENTION_DAYS` 调整。

---

## 三、被别人看到、被搜索引擎收录

这部分代码里已经做好了：

- **服务端直出**：搜索引擎抓到的就是真实的吐槽内容，不是空壳页面
- 每个页面有独立的标题、描述、`canonical`
- 每条吐槽有独立永久链接 `/t/xxxx`，带结构化数据（`DiscussionForumPosting`）
- `robots.txt`、`sitemap.xml`、`rss.xml` 自动生成，新吐槽会自动进 sitemap
- `/about` 页面包含使用说明、内容规范、隐私说明、免责声明（UGC 站点需要这些）
- 图片卡片（分享到微信/QQ 时的缩略图）用的是 `preview.png`，想换就把这张图替换掉

### 上线后要做的三件事

1. **提交 sitemap**：
   - Google：[Google Search Console](https://search.google.com/search-console) → 添加资源 → 提交 `https://你的域名/sitemap.xml`
   - 必应：[Bing 网站管理员](https://www.bing.com/webmasters) → 同上
   - 百度：[百度搜索资源平台](https://ziyuan.baidu.com) → 站点管理 → 普通收录 → 提交 sitemap
2. **让搜索引擎知道有新内容**：sitemap 会自动更新，等它自己来抓就行，不用天天提交。
3. **耐心**：新域名被收录通常要几天到几周，中文内容更快的方式是有人分享你的链接（每条吐槽的 `/t/xxx` 链接很合适）。

> 提醒：`BASE_URL` 一定要设成真实的 `https://域名`。它决定了 sitemap、canonical 和分享卡片里的地址，设错了会影响收录。

---

## 四、部署到公网

三种常见方式，按省事程度排：

### 方式 A：一台服务器 + Docker（推荐，最可控）

准备：一台服务器（阿里云/腾讯云轻量、或国外 VPS 都行）+ 一个域名，域名解析 A 记录指向服务器 IP。

```bash
# 服务器上，进到项目目录
cp .env.example .env
nano .env          # 填 DOMAIN / BASE_URL / ADMIN_PASSWORD / IP_SALT / CONTACT_EMAIL

docker compose up -d --build
```

就这一步。Caddy 会自动申请并续期 HTTPS 证书（需要域名已经解析到这台机器、且 80/443 端口开放）。

数据存在项目目录的 `data/tucao.db`，备份就是复制这个文件。

> **如果服务器在中国大陆**：需要先完成 ICP 备案，否则 80/443 会被拦。备案要 1～3 周，建议早点开始。不想备案就把服务器放在香港/新加坡/日本，或改用方式 B。

### 方式 B：托管平台（不用管服务器）

Render、Railway、Fly.io 这类平台都能直接跑 Node 项目：

1. 把 `outputs` 目录推到一个 Git 仓库（GitHub/Gitee 都行）
2. 在平台上新建 Web Service，指向这个仓库
3. 启动命令填 `node server.js`
4. 环境变量填 `.env.example` 里那几项
5. **必须挂一个持久磁盘**，挂载到 `/data`（数据库要落盘，不然每次重启数据就没了），并设置 `DATA_DIR=/data`

注意：免费套餐通常没有持久磁盘且有休眠，正式用建议最低配的付费实例。

### 方式 C：不用 Docker，直接跑

```bash
# 用 pm2 常驻
npm install -g pm2
ADMIN_PASSWORD=xxx BASE_URL=https://你的域名 PORT=3000 pm2 start server.js --name tucao
pm2 save && pm2 startup

# 前面再挂一层 Nginx 或 Caddy 做 HTTPS 反向代理到 127.0.0.1:3000
```

### 环境变量速查

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | ✅ | 后台密码，设长一点 |
| `BASE_URL` | ✅ | 例：`https://tucao.example.com`，不要结尾斜杠 |
| `IP_SALT` | ✅ | 随机串，用于访客去重和匿名化 IP。生成：`openssl rand -hex 32` |
| `DOMAIN` | Docker 方式 | 你的域名（不带 https://） |
| `CONTACT_EMAIL` | 建议 | 显示在「关于本站」，用于侵权投诉联系 |
| `SITE_NAME` | 可选 | 默认「吐槽铺」 |
| `REQUIRE_REVIEW` | 可选 | `1` = 先审后发；默认 `0` 先发后审 |
| `BANNED_WORDS` | 可选 | 额外屏蔽词，英文逗号分隔，命中后自动进待审 |
| `RETENTION_DAYS` | 可选 | 访问记录保留天数，默认 180 |
| `LOG` | 可选 | `1` 打开请求日志 |

---

## 五、隐私是怎么处理的

匿名站点，这几个点必须说清楚，代码里也是这么实现的：

- **不存 IP**。只存 `sha256(IP + IP_SALT)` 的前 16 位，用来防刷屏和区分访客，无法反推回原 IP。
- **「碎掉」的内容不上传**。碎纸机里的文字只存在访问者自己的浏览器里，服务器只收到「碎了多少字」这一个数字。
- **没有第三方统计、没有广告代码、没有社交平台脚本**。页面不向任何第三方发数据。
- **无账号体系**。只有两个 cookie：一个随机访客编号（统计和防重复点赞），一个后台登录状态。
- 隐私说明写进了 `/about#privacy`，访问者能自己看到。

---

## 六、内容管理建议

吐槽站天然会有情绪化内容，系统里已经做了这些：

- **自动拦截**：手机号、微信/QQ 号、网址、常见广告词（刷单/博彩/贷款等）会被自动拦下放进待审，不会公开。
- **举报入口**：访问者点 🚩，你在后台能看到。
- **封禁来源**：恶意刷屏直接封，配合 `BANNED_WORDS` 使用。
- 骂人本身**不会**被拦 —— 这是吐槽站，情绪需要出口。但辱骂具体的人、泄露他人隐私、广告，请一律隐藏。

如果想更保守，把 `REQUIRE_REVIEW=1`，所有内容都要你点「恢复」才会公开。

---

## 七、文件结构

```
outputs/
├── server.js              服务端：接口 + 服务端渲染 + 统计 + 后台（零依赖）
├── package.json
├── Dockerfile
├── docker-compose.yml     应用 + Caddy（自动 HTTPS）
├── Caddyfile
├── .env.example           环境变量模板
├── preview.png            分享到社交平台时的缩略图，可替换
├── public/
│   ├── render.js          服务端和浏览器共用的渲染逻辑（保证两边一致）
│   ├── index.html         首页模板
│   ├── post.html          单条吐槽的分享页模板
│   ├── about.html         关于 / 隐私 / 内容规范
│   ├── 404.html
│   ├── app.js             前台交互
│   ├── admin.html         后台页面
│   ├── admin.css          后台样式
│   ├── admin.js           后台逻辑（图表是手写的 SVG，没有图表库）
│   ├── styles.css
│   └── favicon.svg
└── data/                  运行时生成：tucao.db（数据库）
```

## 八、备份

复制 `data/tucao.db` 就是完整备份（在跑的也可以复制，SQLite 的 WAL 模式支持热备份）。建议加个定时任务每天拷一份：

```bash
0 4 * * * cp /path/to/outputs/data/tucao.db /path/to/backup/tucao-$(date +\%F).db
```
