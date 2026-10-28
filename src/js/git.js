/* Git 面板：顶栏按钮 + 右侧抽屉。
 *
 * 只读为主，写操作只有「切换分支 / 拉取 / 推送」三件事——
 * merge、rebase、reset、push --force 都故意不做，冲突请回命令行处理。
 * 桌面版才有：浏览器版没有 __TAURI__，整个模块直接不启动。
 */
(() => {
  const T = window.__TAURI__;
  if (!T || !T.core) return;
  const invoke = (cmd, args) => T.core.invoke(cmd, args);
  const $ = (s) => document.querySelector(s);

  const G = {
    open: false,
    info: null,
    files: [],
    log: [],
  logLoaded: false,
    branches: [],
    tab: 'changes',
    picker: false,
    q: '',
    busy: '',
    err: '',
    diffOf: '',
    diffText: '',
    sel: null,        /* Set<path>，null = 还没初始化，首次全选 */
    selTouched: false,/* 用户手动改过勾选后，刷新不再自动全选 */
    msg: '',          /* 提交信息草稿 */
  };

  let btn = null;
  let mask = null;
  let panel = null;
  let dp = null;   /* 左侧的文件 diff 面板 */

  function esc2(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* ---------------- DOM ---------------- */
  function build() {
    if (btn) return;  /* DOMContentLoaded 与 startApp 都可能调到，建一次就够 */
    btn = document.createElement('button');
    btn.className = 'theme-btn shrink-0';
    btn.id = 'git-btn';
    btn.hidden = true;
    btn.title = 'Git 面板';
    btn.setAttribute('aria-label', 'Git');
    btn.innerHTML = '<svg aria-hidden="true"><use href="#i-branch"></use></svg>';
    btn.addEventListener('click', () => (G.open ? close() : openPanel()));
    const themeBtn = $('#theme-btn');
    if (themeBtn && themeBtn.parentNode) themeBtn.parentNode.insertBefore(btn, themeBtn);

    mask = document.createElement('div');
    mask.className = 'gd-mask';
    mask.hidden = true;
    mask.addEventListener('click', () => close());

    panel = document.createElement('aside');
    panel.className = 'gd';
    panel.hidden = true;
    document.body.appendChild(mask);
    document.body.appendChild(panel);
  }

  /* ---------------- 文件 diff 面板（贴在抽屉左侧） ----------------
   * 抽屉只有 420px，unified diff 在这里几乎每行都折行，
   * 所以点变更文件时在左侧另开一块更宽的只读面板。 */
  function buildDiff() {
    if (dp) return;
    dp = document.createElement('aside');
    dp.className = 'gdp';
    dp.hidden = true;
    dp.innerHTML =
      '<div class="gdp-head">' +
        '<span class="gdp-t">Diff</span>' +
        '<span class="gdp-path" id="gdp-path"></span>' +
        '<span class="gdp-nav">' +
          '<button class="gdp-b" data-x="dp-prev" title="上一个改动文件">↑</button>' +
          '<button class="gdp-b" data-x="dp-next" title="下一个改动文件">↓</button>' +
        '</span>' +
        '<button class="gd-x" data-x="dp-close" title="关闭（Esc）">×</button>' +
      '</div>' +
      '<div class="gdp-body"><pre class="gdp-code" id="gdp-code"></pre></div>';
    dp.addEventListener('click', (e) => {
      const el = e.target.closest('[data-x]');
      if (!el) return;
      const x = el.dataset.x;
      if (x === 'dp-close') closeDiff();
      else if (x === 'dp-prev') stepDiff(-1);
      else if (x === 'dp-next') stepDiff(1);
    });
    document.body.appendChild(dp);
  }

  /* 逐行上色。判断顺序要紧：文件头 ---/+++ 也以 +/- 开头，
     先认文件头才不会把 "--- a/x" 画成删除行。 */
  const META_RE = /^(diff --git|index [0-9a-f]|new file mode|deleted file mode|old mode|new mode|similarity index|rename (from|to)|Binary files)/;

  function colorDiff(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
    if (!lines.length) return '';
    return lines.map((l) => {
      const h3 = l.slice(0, 3);
      const h2 = l.slice(0, 2);
      let c = 'dl';
      if (h3 === '+++' || h3 === '---') c += ' hd';
      else if (h2 === '@@') c += ' hunk';
      else if (l.slice(0, 3) === '── ') c += ' meta';   /* git.rs 拼的「已暂存 / 未暂存」分隔行 */
      else if (META_RE.test(l)) c += ' meta';
      else if (l.charAt(0) === '+') c += ' add';
      else if (l.charAt(0) === '-') c += ' del';
      return '<span class="' + c + '">' + (l ? esc2(l) : ' ') + '</span>';
    }).join('');
  }

  async function openFileDiff(p) {
    buildDiff();
    G.diffOf = p;
    render();                    /* 只为了左侧列表高亮 */
    dp.hidden = false;
    paintDiffHead(p);
    $('#gdp-code').innerHTML = '<span class="dl">读取中…</span>';
    $('#gdp-code').scrollTop = 0;
    let text = '';
    try {
      text = await invoke('git_diff', { path: p });
    } catch (err) {
      text = String(err);
    }
    if (G.diffOf !== p) return;  /* 读取期间用户又点了别的文件 */
    G.diffText = text;
    const blank = !text || !text.replace(/\s/g, '');
    $('#gdp-code').innerHTML = blank
      ? '<span class="dl">（这个文件没有可显示的文本差异：可能是二进制文件，或者只改了权限 / 换行符）</span>'
      : colorDiff(text);
  }

  function paintDiffHead(p) {
    const f = G.files.find((x) => x.path === p);
    const st = f
      ? '<span class="gd-st ' + (f.untracked ? 'u' : f.staged ? 's' : 'm') + '">' + esc2(f.label) + '</span>'
      : '';
    $('#gdp-path').innerHTML = st + '<span>' + esc2(p) + '</span>';
    const i = G.files.findIndex((x) => x.path === p);
    const n = G.files.length;
    const prev = dp.querySelector('[data-x="dp-prev"]');
    const next = dp.querySelector('[data-x="dp-next"]');
    if (prev) prev.disabled = n < 2;
    if (next) next.disabled = n < 2;
    dp.title = n ? (i + 1) + ' / ' + n : '';
  }

  function closeDiff() {
    G.diffOf = '';
    G.diffText = '';
    if (dp) dp.hidden = true;
    render();
  }

  function stepDiff(d) {
    if (G.files.length < 2) return;
    const i = G.files.findIndex((x) => x.path === G.diffOf);
    const j = i < 0 ? 0 : (i + d + G.files.length) % G.files.length;
    openFileDiff(G.files[j].path);
  }

  /* ---------------- 数据 ---------------- */
  async function load(what) {
    if (!what || what === 'info') {
      try {
        G.info = await invoke('git_info');
      } catch (e) {
        /* 不能在这里 return：refresh() 末尾才 render，提前退出会让面板永远停在
           「读取 git 状态…」这个加载态上。 */
        G.err = '读取 git 状态失败：' + String(e);
      }
    }
    if (!what || what === 'files') {
      try { G.files = await invoke('git_status'); } catch (e) { G.files = []; }
    }
    if (what === 'log') {
      try { G.log = await invoke('git_log', { limit: 60 }); } catch (e) { G.log = []; }
      G.logLoaded = true;
    }
    if (!what || what === 'branches') {
      try { G.branches = await invoke('git_branches'); } catch (e) { G.branches = []; }
    }
  }

  /* retry：桌面版启动时 app.js 的 init 完成得比 set_config 的状态落定更早，
     第一次 git_info 可能拿不到配置目录。失败就静默重试一次，避免按钮一直藏着。 */
  async function refresh(retry) {
    if (!btn) build();
    G.err = '';
    /* 打开面板只查「分支 + 变更」两项：git log（60 条）和分支列表都是重活，
       分别等到切到历史页、点开分支选择器时再拉。 */
    await load('info');
    await load('files');
    syncSel();
    if (G.info && G.info.isRepo) {
      btn.hidden = false;
      btn.title = 'Git · ' + (G.info.branch || '(detached)') + (G.info.dirty ? ' · ' + G.info.dirty + ' 个变更' : '');
    } else if (!retry) {
      setTimeout(() => refresh(true), 700);
      return;
    }
    if (G.open) render();
  }

  async function openPanel() {
    G.open = true;
    G.err = '';
    mask.hidden = false;
    panel.hidden = false;
    document.body.classList.add('gd-open');
    panel.innerHTML = '<div class="gd-load">读取 git 状态…</div>';
    await refresh();
  }

  function close() {
    G.open = false;
    G.picker = false;
    G.diffOf = '';
    G.diffText = '';
    if (mask) mask.hidden = true;
    if (panel) panel.hidden = true;
    if (dp) dp.hidden = true;
    document.body.classList.remove('gd-open');
  }

  /* ---------------- 渲染 ---------------- */
  function headHtml() {
    const i = G.info || {};
    if (i.error && !i.isRepo) {
      return '<div class="gd-err">' + esc2(i.error) + '</div>';
    }
    if (!i.isRepo) return '<div class="gd-err">这个目录不在 git 仓库里</div>';
    const sync = [];
    if (i.ahead) sync.push('<span class="gd-ab up">↑' + i.ahead + '</span>');
    if (i.behind) sync.push('<span class="gd-ab down">↓' + i.behind + '</span>');
    if (!i.ahead && !i.behind && i.upstream) sync.push('<span class="gd-ab ok">与远端一致</span>');
    if (!i.upstream) sync.push('<span class="gd-ab">没有上游分支</span>');
    return '<div class="gd-repo">' + esc2(i.root) + '</div>' +
      '<button class="gd-branch" data-x="branch" title="切换分支">' +
      '<svg aria-hidden="true"><use href="#i-branch"></use></svg>' +
      '<b>' + esc2(i.branch || '(detached)') + '</b>' +
      (i.detached ? '<span class="gd-tag">游离 HEAD</span>' : '') +
      '<span class="spacer"></span><span class="gd-caret">▾</span></button>' +
      '<div class="gd-syncrow">' + sync.join('') +
      (i.remote ? '<span class="gd-remote" title="' + esc2(i.remote) + '">' + esc2(shortRemote(i.remote)) + '</span>' : '') +
      '</div>' +
      '<div class="gd-acts">' +
      '<button class="btn" data-x="pull"' + (G.busy ? ' disabled' : '') + '>' + (G.busy === 'pull' ? '拉取中…' : '拉取') + '</button>' +
      '<button class="btn" data-x="push"' + (G.busy ? ' disabled' : '') + '>' + (G.busy === 'push' ? '推送中…' : '推送') + '</button>' +
      '<button class="btn" data-x="refresh" title="重新读取"' + (G.busy ? ' disabled' : '') + '>刷新</button>' +
      '</div>' +
      /* 切分支要改写工作区文件，仓库大时可能十几秒没有反馈，这里给一行说明 */
      (G.busy === 'checkout' ? '<div class="gd-note">正在切换分支，文件多的仓库要等十几秒…</div>' : '') +
      (G.err ? '<div class="gd-err">' + esc2(G.err) + '</div>' : '');
  }

  function shortRemote(u) {
    return String(u || '').replace(/^https?:\/\//, '').replace(/\.git$/, '');
  }

  function pickerHtml() {
    const q = G.q.toLowerCase();
    const hit = G.branches.filter((b) => !q || b.name.toLowerCase().indexOf(q) >= 0);
    const local = hit.filter((b) => !b.remote);
    const remote = hit.filter((b) => b.remote);
    const one = (b) => '<button class="gd-bi' + (b.current ? ' cur' : '') + '" data-x="pick" data-b="' + esc2(b.name) + '">' +
      '<span class="gd-bin">' + esc2(b.name) + '</span>' +
      (b.current ? '<span class="gd-tag">当前</span>' : '') + '</button>';
    return '<div class="gd-picker">' +
      '<input class="gd-q" id="gd-q" placeholder="搜分支…" autocomplete="off" value="' + esc2(G.q) + '" />' +
      '<div class="gd-blist">' +
      (local.length ? '<div class="gd-bh">本地</div>' + local.map(one).join('') : '') +
      (remote.length ? '<div class="gd-bh">远程</div>' + remote.map(one).join('') : '') +
      (!hit.length ? '<div class="gd-empty">没有匹配的分支</div>' : '') +
      '</div></div>';
  }

  function filesHtml() {
    if (!G.files.length) return '<div class="gd-empty">工作区干净，没有未提交的改动</div>';
    const picked = selected().length;
    const allOn = picked === G.files.length;
    return '<div class="gd-fbar">' +
      '<label class="gd-ckall"><input type="checkbox" id="gd-ckall"' + (allOn ? ' checked' : '') + ' />' +
      '<span>全选</span></label>' +
      '<span class="gd-sel">已选 ' + picked + ' / ' + G.files.length + '</span></div>' +
      '<div class="gd-files">' + G.files.map((f) => {
      const on = G.diffOf === f.path;
      const ck = isSel(f.path) ? ' checked' : '';
      return '<div class="gd-f' + (on ? ' on' : '') + '">' +
        '<input type="checkbox" class="gd-ck" data-ck="' + esc2(f.path) + '"' + ck + ' title="计入这次提交" />' +
        '<button class="gd-frow" data-x="diff" data-p="' + esc2(f.path) + '">' +
        '<span class="gd-st ' + (f.untracked ? 'u' : f.staged ? 's' : 'm') + '" title="' + esc2(f.code) + '">' + esc2(f.label) + '</span>' +
        '<span class="gd-path">' + esc2(f.path) + '</span></button>' +
        '</div>';
    }).join('') + '</div>';
  }

  /* ---------------- 提交 ---------------- */
  function isSel(p) { return !G.sel || G.sel.has(p); }

  function selected() {
    if (!G.files.length) return [];
    return G.files.map((f) => f.path).filter(isSel);
  }

  function syncSel() {
    const all = G.files.map((f) => f.path);
    if (!G.selTouched) { G.sel = new Set(all); return; }
    const keep = new Set();
    all.forEach((p) => { if (G.sel && G.sel.has(p)) keep.add(p); });
    G.sel = keep;
  }

  function toggleSel(p, on) {
    if (!G.sel) G.sel = new Set(G.files.map((f) => f.path));
    G.selTouched = true;
    if (on) G.sel.add(p); else G.sel.delete(p);
  }

  function commitHtml() {
    const n = selected().length;
    const busy = G.busy === 'commit';
    return '<div class="gd-commit">' +
      '<textarea id="gd-msg" class="gd-msg" rows="3" spellcheck="false"' +
      (busy ? ' disabled' : '') +
      ' placeholder="提交信息（必填），例如：feat: 调整新手引导奖励">' + esc2(G.msg) + '</textarea>' +
      '<div class="gd-cbar">' +
      '<span class="gd-hint">只提交勾选的 ' + n + ' 个文件 · 不会自动推送</span>' +
      '<button class="btn primary" data-x="commit"' + (busy || !n ? ' disabled' : '') + '>' +
      (busy ? '提交中…' : '提交') + '</button>' +
      '</div></div>';
  }

  async function doCommit() {
    if (G.busy) return;
    const msg = (G.msg || '').trim();
    const paths = selected();
    if (!msg) { G.err = '请先填写提交信息'; render(); focusMsg(); return; }
    if (!paths.length) { G.err = '请至少勾选一个文件'; render(); return; }
    G.busy = 'commit';
    G.err = '';
    render();
    try {
      const out = await invoke('git_commit', { message: msg, paths });
      G.msg = '';
      const st = document.getElementById('status');
      if (st) st.textContent = '已提交 ' + (out || '');
      G.logLoaded = false;
      G.selTouched = false;
      await refresh();
      if (G.tab === 'log') await load('log');
    } catch (err) {
      G.err = '提交失败：' + String(err);
    }
    G.busy = '';
    render();
  }

  function focusMsg() {
    const t = panel && panel.querySelector('#gd-msg');
    if (t) { t.focus(); const n = t.value.length; t.setSelectionRange(n, n); }
  }

  function logHtml() {
    if (!G.logLoaded) return '<div class="gd-load">读取提交历史…</div>';
    if (!G.log.length) return '<div class="gd-empty">还没有提交</div>';
    return '<div class="gd-log">' + G.log.map((c) =>
      '<div class="gd-c"><div class="gd-cs">' + esc2(c.subject) + '</div>' +
      '<div class="gd-cm"><span class="gd-hash" title="' + esc2(c.hash) + '">' + esc2(c.short) + '</span>' +
      '<span>' + esc2(c.author) + '</span><span>' + esc2(c.time) + '</span></div></div>').join('') + '</div>';
  }

  function render() {
    if (!panel || panel.hidden) return;
    const dirty = G.info && G.info.isRepo ? (G.info.dirty || 0) : 0;
    const tab = G.tab;
    panel.innerHTML =
      '<div class="gd-head"><b>Git</b>' +
      '<span class="spacer"></span>' +
      '<button class="gd-x" data-x="close" title="关闭（Esc）">×</button></div>' +
      '<div class="gd-top">' + headHtml() + (G.picker ? pickerHtml() : '') + '</div>' +
      (G.info && G.info.isRepo
        ? '<div class="gd-tabs">' +
          '<button class="gd-tab' + (tab === 'changes' ? ' on' : '') + '" data-x="tab" data-t="changes">变更 ' + dirty + '</button>' +
          '<button class="gd-tab' + (tab === 'log' ? ' on' : '') + '" data-x="tab" data-t="log">历史</button>' +
          '</div>' +
          '<div class="gd-body">' + (tab === 'changes' ? filesHtml() : logHtml()) + '</div>' +
          (tab === 'changes' && G.files.length ? commitHtml() : '')
        : '<div class="gd-body"></div>');

    panel.querySelectorAll('[data-x]').forEach((el) => el.addEventListener('click', onAct));

    const ckall = panel.querySelector('#gd-ckall');
    if (ckall) {
      ckall.addEventListener('change', () => {
        G.selTouched = true;
        G.sel = ckall.checked ? new Set(G.files.map((f) => f.path)) : new Set();
        render();
      });
    }
    panel.querySelectorAll('[data-ck]').forEach((el) => el.addEventListener('change', () => {
      toggleSel(el.dataset.ck, el.checked);
      render();
    }));

    const msgBox = panel.querySelector('#gd-msg');
    if (msgBox) {
      /* 打字只更新草稿与计数，不整块重渲染，否则光标会跳 */
      msgBox.addEventListener('input', () => {
        G.msg = msgBox.value;
        const n = selected().length;
        const go = panel.querySelector('[data-x="commit"]');
        if (go) go.disabled = !n;
        const hint = panel.querySelector('.gd-hint');
        if (hint) hint.textContent = '只提交勾选的 ' + n + ' 个文件 · 不会自动推送';
      });
      msgBox.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          doCommit();
        }
      });
    }

    const q = panel.querySelector('#gd-q');
    if (q) {
      q.addEventListener('input', () => { G.q = q.value; const p = q.selectionStart; render(); const n = panel.querySelector('#gd-q'); if (n) { n.focus(); n.setSelectionRange(p, p); } });
      q.focus();
    }
  }

  /* ---------------- 交互 ---------------- */
  async function onAct(e) {
    const el = e.currentTarget;
    const x = el.dataset.x;
    if (x === 'close') return close();
    if (x === 'branch') { G.picker = !G.picker; G.q = ''; if (G.picker) await load('branches'); return render(); }
    if (x === 'refresh') {
      await refresh();
      if (G.tab === 'log') {
        G.logLoaded = false;
        await load('log');
        render();
      }
      return;
    }
    if (x === 'tab') {
      G.tab = el.dataset.t;
      render();
      /* 提交历史按需加载：打开面板时只查分支与变更，history 要切过去才跑 git log */
      if (G.tab === 'log' && !G.logLoaded) {
        await load('log');
        render();
      }
      return;
    }
    if (x === 'pick') {
      const b = el.dataset.b;
      G.busy = 'checkout';
      G.err = '';
      render();
      try {
        await invoke('git_checkout', { branch: b });
        G.picker = false;
      } catch (err) {
        G.err = '切换失败：' + String(err);
      }
      G.busy = '';
      await refresh();
      return;
    }
    if (x === 'pull' || x === 'push') {
      G.busy = x;
      G.err = '';
      render();
      try {
        const out = await invoke(x === 'pull' ? 'git_pull' : 'git_push');
        const st = document.getElementById('status');
        if (st) st.textContent = (x === 'pull' ? '已拉取' : '已推送') + (out ? ' · ' + out.split('\n')[0] : '');
      } catch (err) {
        G.err = (x === 'pull' ? '拉取失败：' : '推送失败：') + String(err);
      }
      G.busy = '';
      await refresh();
      return;
    }
    if (x === 'commit') return doCommit();
    if (x === 'diff') {
      const p = el.dataset.p;
      if (G.diffOf === p && dp && !dp.hidden) closeDiff();
      else await openFileDiff(p);
      return;
    }
  }

  /* Esc 逐层退出：diff 面板 → 分支选择器 → 抽屉本身 */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !G.open || e.defaultPrevented) return;
    e.preventDefault();
    if (dp && !dp.hidden) { closeDiff(); return; }
    if (G.picker) { G.picker = false; render(); return; }
    close();
  });

  window.GIT = {
    open: openPanel,
    close,
    toggle: () => (G.open ? close() : openPanel()),
    refresh,
    state: G,
  };

  /* 启动界面（boot.js）里还没有配置目录，这时候问 git 只会拿到错误；
     真正的第一次读取由 app.js 的 startApp 在 init 完成后调 refresh()。 */
  document.addEventListener('DOMContentLoaded', () => { build(); });
})();