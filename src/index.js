import { PDFDocument } from 'pdf-lib';
import { PAGE_HTML } from './ui.js';

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

async function hasPdfHeader(file) {
  const head = await file.slice(0, 5).arrayBuffer();
  return new TextDecoder().decode(head) === '%PDF-';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function handleMerge(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: '请求格式错误，请使用 multipart/form-data 上传文件。' }, 400);
  }

  const files = form
    .getAll('files')
    .filter((entry) => entry && typeof entry.arrayBuffer === 'function' && entry.size > 0);

  if (files.length === 0) {
    return json({ error: '没有收到任何文件，请使用字段名 files 上传 PDF。' }, 400);
  }
  if (files.length > MAX_FILES) {
    return json({ error: `一次最多合并 ${MAX_FILES} 个 PDF 文件。` }, 400);
  }

  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
    if (file.size > MAX_SINGLE_BYTES) {
      return json({ error: `「${file.name}」超过单文件 ${formatBytes(MAX_SINGLE_BYTES)} 的限制。` }, 400);
    }
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    return json({ error: `文件总大小 ${formatBytes(totalBytes)} 超过 ${formatBytes(MAX_TOTAL_BYTES)} 的限制。` }, 400);
  }

  const merged = await PDFDocument.create();
  let pageCount = 0;

  // 按表单中文件的先后顺序合并，顺序由前端控制。
  for (const file of files) {
    if (!(await hasPdfHeader(file))) {
      return json({ error: `「${file.name}」不是有效的 PDF 文件（文件头不是 %PDF-）。` }, 400);
    }

    let source;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      source = await PDFDocument.load(bytes);
    } catch (error) {
      const message = String(error?.message || error);
      if (/encrypt/i.test(message)) {
        return json({ error: `「${file.name}」是加密 PDF，暂不支持合并，请先解密。` }, 400);
      }
      return json({ error: `「${file.name}」解析失败：${message}` }, 400);
    }

    const indices = source.getPageIndices();
    const pages = await merged.copyPages(source, indices);
    for (const page of pages) merged.addPage(page);
    pageCount += indices.length;
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

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: 'Method Not Allowed' }, 405);
      }
      return new Response(PAGE_HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          ...CORS_HEADERS,
        },
      });
    }

    if (url.pathname === '/merge') {
      if (request.method !== 'POST') {
        return json({ error: 'Method Not Allowed，请使用 POST。' }, 405);
      }
      try {
        return await handleMerge(request);
      } catch (error) {
        return json({ error: `服务器内部错误：${String(error?.message || error)}` }, 500);
      }
    }

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'covert-pdf' });
    }

    return json({ error: 'Not Found' }, 404);
  },
};
