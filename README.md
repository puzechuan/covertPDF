# PDF 工具箱（Cloudflare Worker）

基于 Cloudflare Workers + `pdf-lib` 的 PDF 合并服务，并提供一个完全在浏览器内运行的 PDF 标注编辑器。文件不写数据库、不落盘、不做持久化存储。

## 页面

| 页面 | 说明 |
| --- | --- |
| `/` | 主页面（`public/index.html`），选择「PDF 合并」或「PDF 编辑」 |
| `/merge-pdf.html` | 多文件合并页面 |
| `/edit-pdf.html` | 在线编辑页面 |

## 功能

### PDF 合并（`/merge-pdf.html`）

- 网页端拖拽/多选上传，可调顺序、可移除
- 按列表顺序合并所有页面的 PDF
- 服务端校验文件头（`%PDF-`）、数量与体积，拒绝加密 PDF
- 合并结果以 `application/pdf` 直接下载，响应头带总页数

### PDF 编辑（`/edit-pdf.html`）

- 浏览器内打开 PDF，逐页渲染，支持缩放与页面导航
- 标注工具：自由画笔、高亮、矩形框、文字（支持中文）、橡皮擦
- 每个页面独立撤销与清空，支持删除页面
- 导出时**没有标注的页面直接复制原 PDF 页面**（保留矢量文字）；有标注的页面合成到页面中
- 全程在浏览器内处理，文件不上传到服务器

> 说明：带标注的页面会以约 144 DPI 合成，导出后该页文字不再可选中；未标注的页面不受影响。

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

### `GET /health`

健康检查，返回 `{ "ok": true, "service": "covert-pdf" }`。

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
src/index.js                 Worker 入口：/merge 与 /health、校验、合并、响应
public/index.html            主页面（内联 CSS/JS）
public/merge-pdf.html        合并页面（内联 CSS/JS）
public/edit-pdf.html         编辑页面（内联 CSS/JS）
public/vendor/               pdf.js / pdf-lib 及字体资源（由 npm 包复制，无 CDN 依赖）
public/favicon.svg           SVG 图标
public/favicon.ico           ICO 图标（16px / 32px）
wrangler.toml                Worker 配置（assets.directory = "./public/"）
```

## 构建检查

```bash
npm run build   # dry-run 打包到 dist/，确认无打包错误
```
