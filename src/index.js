import { PDFDocument } from 'pdf-lib';

// Workers 单请求体上限 100MB、内存 128MB，这里留出解析与合并时的余量。
const MAX_FILES = 30;
const MAX_SINGLE_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function hasPdfHeader(file) {
  const head = await file.slice(0, 5).arrayBuffer();
  return new TextDecoder().decode(head) === '%PDF-';
}

// 统一解析 multipart 请求并做数量/体积校验。
async function parsePayload(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return { error: '请求格式错误，请使用 multipart/form-data 上传文件。' };
  }

  const files = form
    .getAll('files')
    .filter((entry) => entry && typeof entry.arrayBuffer === 'function' && entry.size > 0);

  if (files.length === 0) {
    return { error: '没有收到任何文件，请使用字段名 files 上传 PDF。' };
  }
  if (files.length > MAX_FILES) {
    return { error: `一次最多处理 ${MAX_FILES} 个 PDF 文件。` };
  }

  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
    if (file.size > MAX_SINGLE_BYTES) {
      return { error: `「${file.name}」超过单文件 ${formatBytes(MAX_SINGLE_BYTES)} 的限制。` };
    }
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    return { error: `文件总大小 ${formatBytes(totalBytes)} 超过 ${formatBytes(MAX_TOTAL_BYTES)} 的限制。` };
  }

  return { form, files };
}

async function loadSource(file) {
  if (!(await hasPdfHeader(file))) {
    return { error: `「${file.name}」不是有效的 PDF 文件（文件头不是 %PDF-）。` };
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { doc: await PDFDocument.load(bytes) };
  } catch (error) {
    const message = String(error?.message || error);
    if (/encrypt/i.test(message)) {
      return { error: `「${file.name}」是加密 PDF，暂不支持处理，请先解密。` };
    }
    return { error: `「${file.name}」解析失败：${message}` };
  }
}

// selection 是与 files 等长的数组：数组内为 0 基页码，null 表示该文件全选。
// 未提供该字段时全部文件按全页处理，保持原有调用方式兼容。
function parseSelection(form, files) {
  const raw = form.get('selection');
  if (raw === null || raw === undefined || raw === '') return { selection: null };

  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return { error: 'selection 不是合法的 JSON。' };
  }
  if (!Array.isArray(parsed) || parsed.length !== files.length) {
    return { error: 'selection 的数量必须与文件数量一致。' };
  }

  const selection = parsed.map((entry, index) => {
    if (entry === null) return null;
    if (!Array.isArray(entry) || !entry.every((n) => Number.isInteger(n) && n >= 0)) {
      throw new Error(`selection[${index}] 必须是数组或 null，且页码为非负整数。`);
    }
    return [...new Set(entry)];
  });

  return { selection };
}

function resolveIndices(doc, entry, file) {
  const all = doc.getPageIndices();
  if (entry === null) return { indices: all };

  const invalid = entry.filter((n) => n >= all.length);
  if (invalid.length) {
    return { error: `「${file.name}」选择了不存在的第 ${invalid.map((n) => n + 1).join('、')} 页。` };
  }
  return { indices: entry };
}

// 读取每个文件的页数，供页面展示勾选框。文件本身不上传保存，仅在内存中解析。
async function handleInspect(request) {
  const payload = await parsePayload(request);
  if (payload.error) return json({ error: payload.error }, 400);

  const result = [];
  for (const file of payload.files) {
    const loaded = await loadSource(file);
    if (loaded.error) return json({ error: loaded.error }, 400);
    result.push({ name: file.name, pages: loaded.doc.getPageCount() });
  }
  return json({ files: result });
}

async function handleMerge(request) {
  const payload = await parsePayload(request);
  if (payload.error) return json({ error: payload.error }, 400);

  const selectionResult = parseSelection(payload.form, payload.files);
  if (selectionResult.error) return json({ error: selectionResult.error }, 400);
  const selection = selectionResult.selection;

  const merged = await PDFDocument.create();
  let pageCount = 0;

  // 按表单中文件的先后顺序合并；文件内按 selection 给定的页码顺序取页。
  for (let i = 0; i < payload.files.length; i++) {
    const file = payload.files[i];
    const loaded = await loadSource(file);
    if (loaded.error) return json({ error: loaded.error }, 400);

    const resolved = resolveIndices(loaded.doc, selection ? selection[i] : null, file);
    if (resolved.error) return json({ error: resolved.error }, 400);
    if (resolved.indices.length === 0) continue;

    const pages = await merged.copyPages(loaded.doc, resolved.indices);
    for (const page of pages) merged.addPage(page);
    pageCount += resolved.indices.length;
  }

  if (pageCount === 0) {
    return json({ error: '没有选中任何页面，请选择至少一页后再合并。' }, 400);
  }

  let output;
  try {
    output = await merged.save({ useObjectStreams: true });
  } catch (error) {
    return json({ error: `生成合并文件失败：${String(error?.message || error)}` }, 500);
  }

  const filename = `merged-${timestamp()}.pdf`;
  return new Response(output, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(output.byteLength),
      'Cache-Control': 'no-store',
      'X-Merged-Pages': String(pageCount),
      ...CORS_HEADERS,
    },
  });
}

async function handle(request, handler) {
  if (request.method !== 'POST') {
    return json({ error: 'Method Not Allowed，请使用 POST。' }, 405);
  }
  try {
    return await handler(request);
  } catch (error) {
    return json({ error: `服务器内部错误：${String(error?.message || error)}` }, 500);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // "/" 与 "/index.html" 由 public/ 下的静态资源提供，不经过 Worker。
    if (url.pathname === '/inspect') return handle(request, handleInspect);
    if (url.pathname === '/merge') return handle(request, handleMerge);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'covert-pdf' });
    }

    return json({ error: 'Not Found' }, 404);
  },
};
