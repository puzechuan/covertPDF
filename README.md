# PDF 工具箱（Cloudflare Worker）

基于 Cloudflare Workers + `pdf-lib` 的 PDF 工具箱，提供 PDF 合并与浏览器内标注编辑。PDF 文件本身不写数据库、不落盘；用户账号信息保存在云服务数据库中。

## 页面

| 页面 | 说明 |
| --- | --- |
| `/` | 主页面（`public/index.html`），选择「PDF 合并」或「PDF 编辑」 |
| `/merge-pdf.html` | 多文件合并页面 |
| `/edit-pdf.html` | 在线编辑页面 |
| `/init` | 首次初始化管理员（在该页注册的账号成为管理员，仅一次） |
| `/login` | 用户名密码登录 / 注册（注册需图片验证码） |
| `/admin` | 用户管理：注册开关与已注册用户列表 |

两个页面导出时都会弹出系统「另存为」窗口（Chrome / Edge 等支持 File System Access API 的浏览器），可直接在资源管理器里选择保存位置并修改文件名；取消则不会生成文件。Safari / Firefox 等不支持该 API 的浏览器会回退到普通下载，使用带时间戳的默认文件名。

## 功能

### PDF 合并（`/merge-pdf.html`）

- 网页端拖拽/多选上传，可调顺序、可移除
- 按列表顺序合并所有页面的 PDF
- 服务端校验文件头（`%PDF-`）、数量与体积，拒绝加密 PDF
- 合并结果以 `application/pdf` 直接下载，响应头带总页数

### PDF 编辑（`/edit-pdf.html`）

- 浏览器内打开 PDF，逐页渲染，支持缩放与页面导航
- **改字**：点击 PDF 原有文字，预填原文后输入新内容替换（逐字/词粒度，自动采样背景色遮盖）
- 标注工具：自由画笔、高亮、矩形框、文字（支持中文）、橡皮擦
- 每个页面独立撤销与清空，支持删除页面
- 导出时**没有修改的页面直接复制原 PDF 页面**（保留矢量文字）；有修改的页面合成到页面中
- 全程在浏览器内处理，文件不上传到服务器

> 说明：PDF 内的文字不是可编辑对象，改字只能“遮盖原文字 + 重绘新文字”。带修改的页面会以约 144 DPI 合成，导出后该页文字不再可选中；未修改的页面不受影响。扫描件没有文字层，需先 OCR 才能改字。

### 用户系统（Cloudflare D1）

所有功能（首页、PDF 合并、PDF 编辑、用户管理）都需要登录后才能使用。打开任意工具页时会自动检查：未初始化则跳转 `/init`，未登录则跳转 `/login`。`/merge` 接口也在服务端校验登录态，未登录返回 401。

- `/init`：首次访问时创建管理员账号（用户名 + 密码，只能初始化一次）。初始化完成后该页面关闭。
- `/login`：所有用户统一使用用户名 + 密码登录；注册时额外需要图片验证码。不发送邮件。
- `/admin`：管理员可一键关闭 / 开启「允许用户注册」，并查看已注册用户。关闭注册只影响新用户，**已注册用户仍可正常登录，账号数据不受影响**。
- 首页、合并页、编辑页右上角有当前用户头像菜单：普通用户可修改密码、退出登录；管理员额外有「管理中心」入口。
- 登录、注册、初始化成功后默认跳转首页；管理员需要进入管理页时从头像菜单打开「管理中心」。

用户数据保存在 Cloudflare D1 数据库 `covertpdf-db`（Worker binding 名为 `DB`），表结构见根目录的 `init_covertpdf_db.sql`：

| 表 | 用途 |
| --- | --- |
| `users` | 用户名（`username`）、密码哈希（`password_hash`）、角色（admin / user）、注册时间 |
| `captchas` | 图片验证码 token、答案，5 分钟有效，使用后置为已用 |
| `sessions` | 登录会话 token，7 天有效，通过 HttpOnly Cookie 传递 |
| `settings` | `registration_enabled` 注册开关与 `initialized` 初始化状态 |

验证码由 Worker 生成 SVG 图片（带字符旋转与干扰线），无需邮件服务或第三方密钥。点击图片可更换一张。

管理员注册额外需要验证密钥：`wrangler.toml` 的 `[vars].ADMIN_REGISTER_KEY_HASH` 保存密钥的 SHA-256，`/init` 页面输入的密钥经 SHA-256 后与该值比对，错误则拒绝初始化。

**数据库初始化**：无需手动导入。Worker 首次收到 `/auth/*` 或 `/merge` 请求时会自动执行 `init_covertpdf_db.sql` 中的建表语句（`CREATE TABLE IF NOT EXISTS`，同一 isolate 内只执行一次），表结构会自动创建。

`init_covertpdf_db.sql` 仍保留为唯一的 schema 源文件，Worker 通过文本模块直接引用；如需在本地或远端手动初始化，也可以执行：

```bash
npx wrangler d1 execute covertpdf-db --local  --file=./init_covertpdf_db.sql
npx wrangler d1 execute covertpdf-db --remote --file=./init_covertpdf_db.sql
```

## 快速开始

```bash
npm install
npm run dev        # 本地开发，默认 http://localhost:8787
```

浏览器打开 `http://localhost:8787` 进入主页面。

部署到 Cloudflare：

```bash
npm run deploy
```

> 首次部署会提示登录 Cloudflare 账号。如需指定账号或项目名，先执行 `npx wrangler login`，或在 `wrangler.toml` 中修改 `name`。

## API

### `GET /`、`/merge-pdf.html`、`/edit-pdf.html`

由 `public/` 下的静态资源直接提供（不经 Worker）；编辑页所需的 `/vendor/` 资源同理。

### `POST /merge`

请求：`multipart/form-data`，文件字段名为 `files`，可重复提交多个文件；合并顺序即表单中的字段顺序。

```bash
curl -X POST http://localhost:8787/merge \
  -F "files=@a.pdf" \
  -F "files=@b.pdf" \
  -o merged.pdf
```

成功响应：`200`，`Content-Type: application/pdf`，`Content-Disposition: attachment; filename="merged-<时间戳>.pdf"`，`X-Merged-Pages: <总页数>`。

失败响应：JSON，形如 `{ "error": "具体原因" }`，状态码 `400` / `405` / `500`。

### 用户系统 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/auth/captcha` | 返回 `{ token, svg }`，生成图片验证码 |
| `POST` | `/auth/init` | `{ username, password, adminKey }`，首次创建管理员账号（需注册验证密钥） |
| `POST` | `/auth/register` | `{ username, password, captchaToken, captchaCode }`，注册普通用户 |
| `POST` | `/auth/login` | `{ username, password }`，用户名密码登录 |
| `POST` | `/auth/change-password` | `{ currentPassword, newPassword }`，修改当前用户密码 |
| `POST` | `/auth/logout` | 退出登录并清除会话 |
| `GET` | `/auth/me` | 返回当前登录用户，未登录返回 `{ user: null }` |
| `GET` | `/auth/settings` | 返回 `{ registrationEnabled, initialized }` |
| `GET` | `/admin/users` | 管理员获取用户列表 |
| `POST` | `/admin/registration` | 管理员设置 `{ enabled }` 注册开关 |

### `GET /health`

健康检查，返回 `{ "ok": true, "service": "covert-pdf", "db": true }`。

## 限制

| 项目 | 上限 |
| --- | --- |
| 合并：单次文件数 | 30 个 |
| 合并：单文件大小 | 40 MB |
| 合并：单次总大小 | 60 MB |
| 编辑：单文件大小 | 40 MB |
| 编辑：页数 | 100 页 |

Cloudflare Workers 免费版请求体上限为 100 MB、内存约 128 MB，合并限制为其留有余量。超大文件建议拆分处理或改用 R2 + 队列的异步方案。加密 PDF 请先解密后再上传。

## 目录结构

```
src/index.js                 Worker 入口：/merge、用户系统 API、/health、校验与合并
public/index.html            主页面（内联 CSS/JS）
public/merge-pdf.html        合并页面（内联 CSS/JS）
public/edit-pdf.html         编辑页面（内联 CSS/JS）
public/login.html            登录 / 注册页面
public/init.html             首次初始化管理员页面（路由 /init）
public/admin.html            用户管理页面
public/user-menu.js          首页 / 合并页 / 编辑页的右上角用户菜单与改密弹窗
public/vendor/               pdf.js / pdf-lib 及字体资源（由 npm 包复制，无 CDN 依赖）
init_covertpdf_db.sql        D1 初始化脚本（唯一的建表 SQL）
public/favicon.svg           SVG 图标
public/favicon.ico           ICO 图标（16px / 32px）
wrangler.toml                Worker 配置（assets.directory = "./public/"）
```

## 构建检查

```bash
npm run build   # dry-run 打包到 dist/，确认无打包错误
```
