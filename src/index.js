import { PDFDocument } from 'pdf-lib';

// Workers 单请求体上限 100MB、内存 128MB，这里留出解析与合并时的余量。
const MAX_FILES = 30;
const MAX_SINGLE_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

const COOKIE_NAME = 'pdf_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const CODE_SECONDS = 5 * 60;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
      ...extraHeaders,
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

// ---------- 用户系统辅助函数 ----------

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && email.length <= 254;
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function sessionToken(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]+)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function sessionCookie(token, request, maxAge = SESSION_SECONDS) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function currentUser(request, env) {
  const token = sessionToken(request);
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  return (
    (await env.DB.prepare(
      'SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'
    )
      .bind(token, now)
      .first()) || null
  );
}

async function requireAdmin(request, env) {
  const user = await currentUser(request, env);
  if (!user) return { error: json({ error: '请先登录。' }, 401) };
  if (user.role !== 'admin') return { error: json({ error: '需要管理员权限。' }, 403) };
  return { user };
}

async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

async function setSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value))
    .run();
}

const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomInt(max) {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] % max;
}

function generateCaptchaCode() {
  let code = '';
  for (let i = 0; i < 5; i++) code += CAPTCHA_CHARS[randomInt(CAPTCHA_CHARS.length)];
  return code;
}

function captchaSvg(code) {
  const width = 150;
  const height = 48;
  const parts = [`<rect width="100%" height="100%" fill="#f8fafc"/>`];
  for (let i = 0; i < code.length; i++) {
    const x = 14 + i * 27;
    const y = 33 + randomInt(7) - 3;
    const rotate = randomInt(40) - 20;
    const hue = randomInt(360);
    parts.push(
      `<text x="${x}" y="${y}" transform="rotate(${rotate} ${x} ${y})" font-family="Arial, sans-serif" font-size="26" font-weight="bold" fill="hsl(${hue}, 65%, 35%)">${code[i]}</text>`
    );
  }
  for (let i = 0; i < 4; i++) {
    const x1 = randomInt(width), y1 = randomInt(height);
    const x2 = randomInt(width), y2 = randomInt(height);
    parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="hsl(${randomInt(360)}, 50%, 60%)" stroke-width="1" opacity="0.6"/>`
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;
}

async function consumeCaptcha(env, token, code) {
  if (!token || !code) return false;
  const now = Math.floor(Date.now() / 1000);
  const answer = String(code).trim().toUpperCase();
  const row = await env.DB.prepare(
    'SELECT id FROM captchas WHERE token = ? AND code = ? AND used = 0 AND expires_at > ? LIMIT 1'
  )
    .bind(String(token), answer, now)
    .first();
  if (!row) return false;
  await env.DB.prepare('UPDATE captchas SET used = 1 WHERE id = ?').bind(row.id).run();
  return true;
}

async function createSession(env, request, userId) {
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, expires)
    .run();
  return sessionCookie(token, request);
}

// ---------- 用户系统路由 ----------

async function handleCaptcha(request, env) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('DELETE FROM captchas WHERE expires_at < ?').bind(now - 60).run();
  const code = generateCaptchaCode();
  const token = crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare('INSERT INTO captchas (token, code, expires_at) VALUES (?, ?, ?)')
    .bind(token, code, now + CODE_SECONDS)
    .run();
  return json({ token, svg: captchaSvg(code) });
}

async function handleRegister(request, env) {
  const body = await readBody(request);
  if (!body || !isValidEmail(body.email)) return json({ error: '请输入有效的邮箱地址。' }, 400);
  const email = body.email.trim().toLowerCase();
  const isInit = body.isInit === true;

  if (isInit && (await getSetting(env, 'initialized')) === '1') {
    return json({ error: '管理员已初始化，无需重复操作。' }, 403);
  }
  if (!isInit && (await getSetting(env, 'registration_enabled')) === '0') {
    return json({ error: '当前已关闭用户注册。' }, 403);
  }
  if (!(await consumeCaptcha(env, body.captchaToken, body.captchaCode))) {
    return json({ error: '图片验证码错误或已过期。' }, 400);
  }
  if (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()) {
    return json({ error: '该邮箱已注册。' }, 400);
  }

  const role = isInit ? 'admin' : 'user';
  const result = await env.DB.prepare('INSERT INTO users (email, role) VALUES (?, ?)').bind(email, role).run();
  const userId = result.meta && result.meta.last_row_id;
  if (!userId) return json({ error: '创建用户失败。' }, 500);
  if (isInit) await setSetting(env, 'initialized', '1');

  const cookie = await createSession(env, request, userId);
  return json({ ok: true, user: { id: userId, email, role } }, 200, { 'Set-Cookie': cookie });
}

async function handleLogin(request, env) {
  const body = await readBody(request);
  if (!body || !isValidEmail(body.email)) return json({ error: '请输入有效的邮箱地址。' }, 400);
  const email = body.email.trim().toLowerCase();
  const user = await env.DB.prepare('SELECT id, email, role FROM users WHERE email = ?').bind(email).first();
  if (!user) return json({ error: '该邮箱尚未注册。' }, 400);
  if (!(await consumeCaptcha(env, body.captchaToken, body.captchaCode))) {
    return json({ error: '图片验证码错误或已过期。' }, 400);
  }
  const cookie = await createSession(env, request, user.id);
  return json({ ok: true, user }, 200, { 'Set-Cookie': cookie });
}

async function handleLogout(request, env) {
  const token = sessionToken(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', request, 0) });
}

async function handleAdminUsers(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  const result = await env.DB.prepare('SELECT id, email, role, created_at FROM users ORDER BY id').all();
  return json({ users: result.results || [] });
}

async function handleAdminRegistration(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  const body = await readBody(request);
  if (!body || typeof body.enabled !== 'boolean') return json({ error: '参数错误。' }, 400);
  await setSetting(env, 'registration_enabled', body.enabled ? '1' : '0');
  return json({ ok: true, registrationEnabled: body.enabled });
}

// ---------- PDF 合并 ----------

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
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/merge') {
      if (request.method !== 'POST') return json({ error: 'Method Not Allowed，请使用 POST。' }, 405);
      try {
        return await handleMerge(request);
      } catch (error) {
        return json({ error: `服务器内部错误：${String(error?.message || error)}` }, 500);
      }
    }

    if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/admin/')) {
      if (!env.DB) return json({ error: '数据库未配置。' }, 500);
      try {
        if (url.pathname === '/auth/captcha' && request.method === 'GET') return await handleCaptcha(request, env);
        if (url.pathname === '/auth/register' && request.method === 'POST') return await handleRegister(request, env);
        if (url.pathname === '/auth/login' && request.method === 'POST') return await handleLogin(request, env);
        if (url.pathname === '/auth/logout' && request.method === 'POST') return await handleLogout(request, env);
        if (url.pathname === '/auth/me' && request.method === 'GET') {
          return json({ user: await currentUser(request, env) });
        }
        if (url.pathname === '/auth/settings' && request.method === 'GET') {
          return json({
            registrationEnabled: (await getSetting(env, 'registration_enabled')) !== '0',
            initialized: (await getSetting(env, 'initialized')) === '1',
          });
        }
        if (url.pathname === '/admin/users' && request.method === 'GET') return await handleAdminUsers(request, env);
        if (url.pathname === '/admin/registration' && request.method === 'POST') return await handleAdminRegistration(request, env);
        return json({ error: 'Not Found' }, 404);
      } catch (error) {
        return json({ error: `服务器内部错误：${String(error?.message || error)}` }, 500);
      }
    }

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'covert-pdf', db: !!env.DB });
    }

    return json({ error: 'Not Found' }, 404);
  },
};
