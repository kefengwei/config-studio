/* 启动器（只对 Tauri 桌面版生效）
 *
 * 桌面版没有 config-dir.txt 可找，启动时先让用户选配置仓库目录：
 *   · 有历史记录 → 列出来，点一下直接进
 *   · 没有 → 「选择文件夹」走系统对话框
 * 选好后把目录存在 Rust 侧（进程内），再启动工作台。
 * 想换目录：点顶栏的仓库名 → 清空状态 + 重载 → 回到这里。
 *
 * 浏览器模式（启动.bat + PowerShell 服务）完全不介入，__HOLD_INIT__ 不设。
 */
(function () {
  const T = window.__TAURI__;
  if (!T || !T.core) return;                 // 浏览器模式：直接放行

  const invoke = (cmd, args) => T.core.invoke(cmd, args);
  const dialog = T.dialog;

  window.__HOLD_INIT__ = true;               // 先别让 app.js 初始化，等目录选好

  let mask = null;
  let busy = false;
  let errorEl = null;

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function icon(id, size) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'boot-ico');
    s.setAttribute('width', size || 16);
    s.setAttribute('height', size || 16);
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', '#' + id);
    s.appendChild(u);
    return s;
  }

  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function setError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg || '';
    errorEl.hidden = !msg;
  }

  function build() {
    if (mask) return mask;
    mask = el('div', 'boot-mask');
    const card = el('div', 'boot-card');

    const head = el('div', 'boot-head');
    head.appendChild(el('div', 'boot-logo', '<svg width="26" height="26" aria-hidden="true"><use href="#i-grid"></use></svg>'));
    const titleWrap = el('div', 'boot-titles');
    titleWrap.appendChild(el('div', 'boot-title', '配置工作台'));
    titleWrap.appendChild(el('div', 'boot-sub', '选一个配置仓库目录开始。目录下需要有 <b>configs/Config_*.json</b>。'));
    head.appendChild(titleWrap);
    card.appendChild(head);

    const pick = el('button', 'boot-pick');
    pick.type = 'button';
    pick.appendChild(icon('i-folder', 16));
    pick.appendChild(el('span', null, '选择文件夹…'));
    pick.addEventListener('click', chooseFolder);
    card.appendChild(pick);

    errorEl = el('div', 'boot-err');
    errorEl.hidden = true;
    card.appendChild(errorEl);

    const recentWrap = el('div', 'boot-recent');
    recentWrap.appendChild(el('div', 'boot-sec', '最近打开'));
    const list = el('div', 'boot-list', '<div class="boot-empty">还没有打开过任何目录</div>');
    list.id = 'boot-list';
    recentWrap.appendChild(list);
    card.appendChild(recentWrap);

    const foot = el('div', 'boot-foot', '也可以把本程序放进配置仓库旁边，用 <b>config-dir.txt</b> 指定目录。');
    card.appendChild(foot);

    mask.appendChild(card);
    document.body.appendChild(mask);
    mask.hidden = true;
    return mask;
  }

  function renderRecent(items) {
    const list = document.getElementById('boot-list');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = '<div class="boot-empty">还没有打开过任何目录</div>';
      return;
    }
    list.innerHTML = '';
    for (const r of items) {
      const row = el('div', 'boot-row' + (r.exists ? '' : ' gone'));
      row.dataset.path = r.path;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.title = r.path + (r.exists ? '' : '（目录已不存在）');
      const main = el('div', 'boot-row-main');
      main.appendChild(el('div', 'boot-row-name', esc(r.name)));
      main.appendChild(el('div', 'boot-row-path', esc(r.path)));
      row.appendChild(main);
      const meta = el('div', 'boot-row-meta');
      meta.innerHTML = '<span class="boot-badge">' + (r.tables || 0) + ' 张表</span>' + (r.last ? '<span class="boot-when">' + fmtTime(r.last) + '</span>' : '');
      row.appendChild(meta);
      const del = el('button', 'boot-x', '×');
      del.type = 'button';
      del.title = '从列表里移除';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await invoke('remove_recent', { path: r.path });
          r.__removed = true;
          row.remove();
          if (!list.children.length) list.innerHTML = '<div class="boot-empty">还没有打开过任何目录</div>';
        } catch (e) { setError('移除失败：' + e); }
      });
      row.appendChild(del);
      row.addEventListener('click', () => pick(r.path));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(r.path); }
      });
      list.appendChild(row);
    }
  }

  /* 重载页面但丢掉 hash（上一个配置仓库的 #/表/行 对新仓库没有意义） */
  function go(path) {
    try { location.replace(path || '/'); } catch (e) { location.reload(); }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function chooseFolder() {
    if (busy) return;
    setError('');
    let picked = null;
    try {
      picked = await dialog.open({ directory: true, multiple: false, title: '选择配置仓库目录（含 configs 文件夹）' });
    } catch (e) {
      setError('打开对话框失败：' + e);
      return;
    }
    if (!picked) return;
    await pick(typeof picked === 'string' ? picked : picked[0]);
  }

  async function pick(path) {
    if (busy || !path) return;
    busy = true;
    setError('');
    mask.classList.add('busy');
    try {
      const info = await invoke('set_config', { path });
      await enter(info);
    } catch (e) {
      setError(String(e));
    } finally {
      busy = false;
      if (mask) mask.classList.remove('busy');
    }
  }

  async function enter(info) {
    if (typeof window.__START_APP__ === 'function') {
      hide();
      window.__START_APP__();
    } else {
      /* 已经在工作台里换了目录：重载页面，把前端缓存全部丢掉。
         地址里的 #/表/行 是上一个仓库的，一起丢掉，否则进去会跳到一个不存在的行。 */
      go('/');
    }
  }

  function show(items) {
    build();
    mask.hidden = false;
    mask.classList.remove('boot-out');
    renderRecent(items || []);
    setError('');
    /* 默认焦点落在「选择文件夹」，回车就能开对话框 */
    const btn = mask.querySelector('.boot-pick');
    if (btn) setTimeout(() => btn.focus(), 30);
  }

  function hide() {
    if (!mask) return;
    mask.classList.add('boot-out');
    setTimeout(() => { if (mask) mask.hidden = true; }, 140);
  }

  async function boot() {
    let cur = null;
    try { cur = await invoke('get_config'); } catch (e) { /* 首次运行没有状态 */ }
    if (cur) {
      /* 已有目录（理论上不会走到这里，因为启动时状态是空的）：直接进 */
      if (typeof window.__START_APP__ === 'function') window.__START_APP__();
      return;
    }
    let list = [];
    try { list = await invoke('list_recent'); } catch (e) { list = []; }
    show(list);
  }

  /* 顶栏仓库名：点一下回去换目录 */
  function bindSwitch() {
    const repo = document.getElementById('stat-repo');
    if (!repo) return;
    repo.style.cursor = 'pointer';
    repo.title = '切换配置目录';
    repo.addEventListener('click', async () => {
      try { await invoke('clear_config'); } catch (e) { /* ignore */ }
      go('/');
    });
  }

  window.addEventListener('DOMContentLoaded', () => {
    bindSwitch();
    boot().catch((e) => { setError('启动失败：' + e); build(); mask.hidden = false; });
  });
})();
