(function () {
  'use strict';
  if (window.__userMenuLoaded) return;
  window.__userMenuLoaded = true;

  var user = null;
  var root = null;
  var menu = null;
  var overlay = null;
  var statusEl = null;

  var style = document.createElement('style');
  style.textContent = [
    '.um-root{position:relative;display:inline-block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
    '.um-root.um-fixed{position:fixed;top:14px;right:16px;z-index:2147483000}',
    '.um-btn{display:flex;align-items:center;gap:8px;border:0;background:transparent;padding:0;cursor:pointer}',
    '.um-avatar{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;font-weight:700;font-size:15px;box-shadow:0 4px 12px rgba(79,70,229,.28);border:2px solid #fff;line-height:1}',
    '.um-btn:hover .um-avatar{filter:brightness(1.05)}',
    '.um-menu{position:absolute;right:0;top:44px;min-width:214px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 14px 36px rgba(17,24,39,.16);padding:6px;z-index:2147483000}',
    '.um-head{padding:8px 10px 10px;border-bottom:1px solid #f1f5f9;margin-bottom:4px}',
    '.um-name{font-size:13px;font-weight:600;color:#1f2937;word-break:break-all}',
    '.um-role{font-size:11px;color:#6b7280;margin-top:1px}',
    '.um-item{display:block;width:100%;text-align:left;border:0;background:transparent;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px;color:#374151;font-family:inherit;text-decoration:none;box-sizing:border-box}',
    '.um-item:hover{background:#f3f4f6}',
    '.um-item.danger{color:#dc2626}',
    '.um-item.danger:hover{background:#fef2f2}',
    '.um-hint{display:block;font-size:11px;color:#9ca3af;margin-top:1px}',
    '.um-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:2147483001;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}',
    '.um-modal{background:#fff;color:#1f2937;border-radius:16px;padding:22px;width:100%;max-width:380px;box-shadow:0 24px 60px rgba(15,23,42,.25);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-sizing:border-box}',
    '.um-modal h3{margin:0 0 4px;font-size:17px}',
    '.um-modal .um-sub{margin:0 0 16px;font-size:12px;color:#6b7280;word-break:break-all}',
    '.um-modal label{display:block;font-size:12px;color:#6b7280;margin:12px 0 5px}',
    '.um-modal input{width:100%;border:1px solid #e5e7eb;border-radius:8px;padding:9px 11px;font-family:inherit;font-size:14px;outline:none;box-sizing:border-box}',
    '.um-modal input:focus{border-color:#4f46e5;box-shadow:0 0 0 2px #eef2ff}',
    '.um-status{min-height:20px;font-size:12px;color:#6b7280;margin-top:10px}',
    '.um-status.error{color:#dc2626}',
    '.um-status.success{color:#059669}',
    '.um-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}',
    '.um-actions button{border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;font-family:inherit}',
    '.um-cancel{border:1px solid #e5e7eb;background:#fff;color:#6b7280}',
    '.um-save{border:0;background:#4f46e5;color:#fff;font-weight:600}',
    '.um-save:disabled{opacity:.55;cursor:wait}',
    '.um-root [hidden],.um-overlay[hidden]{display:none !important}'
  ].join('');
  document.head.appendChild(style);

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, options) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {})).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('请求失败（HTTP ' + res.status + '）'));
        return data;
      });
    });
  }

  function closeMenu() {
    if (menu) menu.hidden = true;
  }

  function build() {
    root = document.createElement('div');
    root.className = 'um-root';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'um-btn';
    btn.setAttribute('aria-label', '用户菜单');
    btn.title = user.username;
    var avatar = document.createElement('span');
    avatar.className = 'um-avatar';
    avatar.textContent = String(user.username || '?').slice(0, 1).toUpperCase();
    btn.appendChild(avatar);

    menu = document.createElement('div');
    menu.className = 'um-menu';
    menu.hidden = true;
    menu.innerHTML =
      '<div class="um-head">' +
        '<div class="um-name">' + esc(user.username) + '</div>' +
        '<div class="um-role">' + (user.role === 'admin' ? '管理员' : '普通用户') + '</div>' +
      '</div>' +
      '<button type="button" class="um-item" data-action="password">编辑用户信息<span class="um-hint">修改登录密码</span></button>' +
      (user.role === 'admin' ? '<a class="um-item" href="/admin" data-action="admin">管理中心</a>' : '') +
      '<button type="button" class="um-item danger" data-action="logout">退出登录</button>';

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    menu.addEventListener('click', function (e) {
      var item = e.target.closest('[data-action]');
      if (!item) return;
      var action = item.getAttribute('data-action');
      if (action === 'password') {
        closeMenu();
        openModal();
      } else if (action === 'logout') {
        closeMenu();
        doLogout();
      }
    });

    root.appendChild(btn);
    root.appendChild(menu);

    var mount = document.querySelector('[data-user-menu]');
    if (mount) {
      mount.appendChild(root);
    } else {
      root.className += ' um-fixed';
      document.body.appendChild(root);
    }
  }

  function openModal() {
    if (overlay) overlay.hidden = false;
    var cur = document.getElementById('umCurrent');
    var next = document.getElementById('umNew');
    var confirm = document.getElementById('umConfirm');
    if (cur) cur.value = '';
    if (next) next.value = '';
    if (confirm) confirm.value = '';
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'um-status'; }
    if (cur) cur.focus();
  }

  function buildModal() {
    overlay = document.createElement('div');
    overlay.className = 'um-overlay';
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="um-modal" role="dialog" aria-modal="true" aria-label="编辑用户信息">' +
        '<h3>编辑用户信息</h3>' +
        '<p class="um-sub">用户名：' + esc(user.username) + '</p>' +
        '<label for="umCurrent">当前密码</label>' +
        '<input type="password" id="umCurrent" autocomplete="current-password">' +
        '<label for="umNew">新密码</label>' +
        '<input type="password" id="umNew" placeholder="至少 6 位" autocomplete="new-password">' +
        '<label for="umConfirm">确认新密码</label>' +
        '<input type="password" id="umConfirm" placeholder="再次输入新密码" autocomplete="new-password">' +
        '<div class="um-status" id="umStatus"></div>' +
        '<div class="um-actions">' +
          '<button type="button" class="um-cancel" id="umCancel">取消</button>' +
          '<button type="button" class="um-save" id="umSave">保存</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    statusEl = document.getElementById('umStatus');

    document.getElementById('umCancel').addEventListener('click', function () {
      overlay.hidden = true;
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.hidden = true;
    });
    document.getElementById('umSave').addEventListener('click', savePassword);
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') overlay.hidden = true;
    });
  }

  async function savePassword() {
    var cur = document.getElementById('umCurrent').value;
    var next = document.getElementById('umNew').value;
    var confirm = document.getElementById('umConfirm').value;
    var saveBtn = document.getElementById('umSave');

    function setStatus(text, kind) {
      statusEl.textContent = text;
      statusEl.className = 'um-status' + (kind ? ' ' + kind : '');
    }

    if (!cur || !next) { setStatus('请填写当前密码和新密码。', 'error'); return; }
    if (next.length < 6) { setStatus('新密码至少 6 位。', 'error'); return; }
    if (next !== confirm) { setStatus('两次输入的新密码不一致。', 'error'); return; }

    saveBtn.disabled = true;
    setStatus('正在保存…');
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: cur, newPassword: next })
      });
      setStatus('密码已修改。', 'success');
      setTimeout(function () { overlay.hidden = true; }, 900);
    } catch (e) {
      setStatus(e.message, 'error');
    }
    saveBtn.disabled = false;
  }

  async function doLogout() {
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) {}
    window.location.href = '/login';
  }

  document.addEventListener('click', function () { closeMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

  api('/auth/me').then(function (data) {
    if (!data.user) return;
    user = data.user;
    build();
    buildModal();
  }).catch(function () {});
})();
