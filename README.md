# PDF 合并（Cloudflare Worker）

基于 Cloudflare Workers + `pdf-lib` 的 PDF 合并服务。文件在 Worker 内存中完成合并后直接下载，不写数据库、不落盘、不做持久化存储。

## 功能

- 网页端拖拽/多选上传，可调顺序、可移除
- 每个文件可展开选择部分页面（页码勾选、全选/反选、范围输入），默认全选
- 按列表顺序合并所选页面
- 服务端校验文件头（ `%PDF-` ）、数量与体积，拒绝加密 PDF
- 合并结果以 `application/pdf` 直接下载，响应头带总页数
- 独立的 `public/index.html`（内联 CSS/JS，无外部依赖）与 SVG/ICO favicon，由静态资源直接提供

## 快速开始

```bash
npm install
npm run dev        # 本地开发，默认 http://localhost:8787
```

浏览器打开 `http://localhost:8787`，选择多个 PDF，点击「开始合并」。

部署到 Cloudflare：

```bash
npm run deploy
```

> 首次部署会提示登录 Cloudflare 账号。如需指定账号或项目名，先执行 `npx wrangler login`，或在 `wrangler.toml` 中修改 `name`。

## API

### `GET /`

由 `public/index.html` 静态资源直接提供上传页面（不经 Worker）；`GET /favicon.svg`、`GET /favicon.ico` 同理。

### `POST /inspect`

请求：`multipart/form-data`，文件字段名 `files`。返回 `{ "files": [{ "name": "...", "pages": 3 }] }`，供页面生成页码勾选框；文件只在内存中解析。

### `POST /merge`

请求：`multipart/form-data`，文件字段名为 `files`，可重复提交多个文件；合并顺序即表单中的字段顺序。

可选字段 `selection`：JSON 数组，与 `files` 等长；每项是 0 基页码数组（按给定顺序取页），或 `null` 表示该文件取全部页面。省略时按全部页面合并。

```bash
curl -X POST http://localhost:8787/merge \
  -F "files=@a.pdf" \
  -F "files=@b.pdf" \
  -o merged.pdf

# 只取 a.pdf 的第 1、3 页和 b.pdf 的全部页面
curl -X POST http://localhost:8787/merge \
  -F "files=@a.pdf" \
  -F "files=@b.pdf" \
  -F 'selection=[[0,2],null]' \
  -o merged.pdf
```

成功响应：`200`，`Content-Type: application/pdf`，`Content-Disposition: attachment; filename="merged-<时间戳>.pdf"`，`X-Merged-Pages: <总页数>`。

失败响应：JSON，形如 `{ "error": "具体原因" }`，状态码 `400` / `405` / `500`。

### `GET /health`

健康检查，返回 `{ "ok": true, "service": "covert-pdf" }`。

## 限制

| 项目 | 上限 |
| --- | --- |
| 单次文件数 | 30 个 |
| 单文件大小 | 40 MB |
| 单次总大小 | 60 MB |

Cloudflare Workers 免费版请求体上限为 100 MB、内存约 128 MB，上述限制为其留有余量。超大文件建议拆分处理或改用 R2 + 队列的异步方案。加密 PDF 请先解密后再上传。

## 目录结构

```
src/index.js          Worker 入口：/merge 与 /health、校验、合并、响应
public/index.html     独立上传页面（内联 CSS/JS）
public/favicon.svg    SVG 图标
public/favicon.ico    ICO 图标（16px / 32px）
wrangler.toml         Worker 配置（assets.directory = "./public/"）
```

## 构建检查

```bash
npm run build   #  dry-run 打包到 dist/，确认无打包错误
```
