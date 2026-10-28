/* 布局：右栏宽度可拖动，宽度记在 localStorage。
   宽度只是一个 CSS 变量 --detail-w，网格列与拖动手柄都跟着它走。 */
(function () {
  const KEY = 'wb.detailW';
  const MIN = 300;          // 右栏自身的最小宽度
  const CENTER_MIN = 128;   // 中间表格被压到 128px 就不再让右栏继续变宽
  const DEFAULT = 400;
  const root = document.documentElement;

  /* ---------- 主题：跟随系统 + 手动覆盖 ----------
     系统开了「自动暗色」时按系统走；点按钮锁定，右键恢复跟随系统。 */
  const TKEY = 'wb.theme';
  const themeBtn = document.getElementById('theme-btn');
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)');
  /* ?theme=dark|light 临时覆盖（用于分享指定主题的链接，不写 localStorage） */
  function urlTheme() {
    try { const v = new URLSearchParams(location.search).get('theme'); return v === 'dark' || v === 'light' ? v : null; } catch (e) { return null; }
  }
  function dropUrlTheme() {
    if (!urlTheme()) return;
    try {
      const u = new URL(location.href);
      u.searchParams.delete('theme');
      history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    } catch (e) {}
  }
  function savedTheme() {
    const u = urlTheme();
    if (u) return u;
    try { const v = localStorage.getItem(TKEY); return v === 'dark' || v === 'light' ? v : 'auto'; } catch (e) { return 'auto'; }
  }
  function effective() {
    const s = savedTheme();
    return s === 'auto' ? (sysDark.matches ? 'dark' : 'light') : s;
  }
  function applyTheme() {
    const s = savedTheme();
    root.classList.toggle('dark', s === 'dark');
    root.classList.toggle('light', s === 'light');
    /* 页面锁成浅色/暗色时，原生控件（datalist 下拉、scrollbar、select 弹层）也要跟着走。
       只设 meta color-scheme: light dark 的话它们仍按系统偏好上色，浅色页面上会弹出黑底下拉。 */
    root.style.colorScheme = effective();
    if (themeBtn) {
      const eff = effective();
      /* 暗色时显示太阳（点它切回浅色），浅色时显示月亮 */
      themeBtn.innerHTML = '<svg aria-hidden="true"><use href="#' + (eff === 'dark' ? 'i-sun' : 'i-moon') + '"></use></svg>';
      themeBtn.title = '当前：' + (eff === 'dark' ? '暗色' : '浅色') + '（点击切换，右键恢复跟随系统）';
    }
  }
  function toggleTheme() {
    const next = effective() === 'dark' ? 'light' : 'dark';
    dropUrlTheme();
    try { localStorage.setItem(TKEY, next); } catch (e) {}
    applyTheme();
  }
  /* 快捷键 T 与顶栏按钮走同一个入口 */
  window.LAYOUT = { toggleTheme: toggleTheme, effective: effective, editFocus: editFocus };
  if (themeBtn) {
    themeBtn.onclick = toggleTheme;
    themeBtn.oncontextmenu = (e) => {
      e.preventDefault();
      try { localStorage.removeItem(TKEY); } catch (e) {}
      dropUrlTheme();
      applyTheme();
    };
    sysDark.addEventListener('change', () => { if (savedTheme() === 'auto') applyTheme(); });
    applyTheme();
  }

  // desired = 用户想要的宽度；实际渲染的宽度还要受窗口大小夹紧。
  // 窗口变窄时右栏视觉上收窄，变宽后自动恢复，不会把用户设置永久改小。
  let desired = DEFAULT;

  function apply(w) {
    desired = Math.round(w);
    root.style.setProperty('--detail-w', clamp(desired) + 'px');
  }

  function current() {
    return desired;
  }

  function clamp(w) {
    // 上限由窗口决定：侧栏 248 + 中间最少 128
    const maxByWindow = Math.max(MIN, window.innerWidth - 248 - CENTER_MIN);
    return Math.min(maxByWindow, Math.max(MIN, w));
  }

  /* ---------- 编辑聚焦 ----------
     进编辑/新增表单时，右栏自动拉宽到「中间只剩 RowName 那一列」，
     退出时还原成进入前的宽度。用户在这期间拖动的手柄也不会被记进 localStorage，
     否则下次启动就会套用一个超宽的右栏。 */
  let beforeFocus = null;

  /* 编辑时中栏该留多宽：刚好装下最长 RowName，但仍低于 narrow 阈值（320），
     这样中栏自动切到「只显示 RowName」的单列模式，行名不被截断。 */
  function centerNeed() {
    let max = 0;
    try {
      const rows = (typeof state !== 'undefined' && state.rows) || [];
      for (const r of rows) max = Math.max(max, String((r && r.RowName) || '').length);
    } catch (e) {}
    return Math.min(300, Math.max(180, Math.round(22 + max * 7.6)));
  }

  function editFocus(on) {
    if (on) {
      if (beforeFocus !== null) return;
      beforeFocus = clamp(current());
      apply(window.innerWidth - 248 - centerNeed());
      document.body.classList.add('edit-focus');
    } else {
      if (beforeFocus === null) return;
      apply(beforeFocus);
      beforeFocus = null;
      document.body.classList.remove('edit-focus');
    }
  }

  /* 只接受「这个窗口里放得下」的历史宽度。localStorage 里如果留着别的窗口尺寸下算出来的
     巨大值（比如 1180），直接套上去会让中间表格只剩一两百像素，看起来像布局坏了。 */
  const saved = parseInt(localStorage.getItem(KEY) || '', 10);
  const savedMax = Math.max(MIN, window.innerWidth - 248 - CENTER_MIN);
  if (Number.isFinite(saved) && saved >= MIN && saved <= savedMax) {
    apply(saved);
  } else if (Number.isFinite(saved)) {
    try { localStorage.removeItem(KEY); } catch (e) {}
  }

  const grip = document.getElementById('detail-grip');
  const detail = document.getElementById('detail');
  if (!grip || !detail) return;

  let dragging = false;
  let startX = 0;
  let startW = 0;

  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startW = detail.getBoundingClientRect().width;
    grip.classList.add('dragging');
    document.body.classList.add('col-resizing');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function onMove(e) {
    if (!dragging) return;
    apply(clamp(startW - (e.clientX - startX)));
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    grip.classList.remove('dragging');
    document.body.classList.remove('col-resizing');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    /* 编辑聚焦期间的临时加宽不落盘，退出编辑会还原 */
    if (beforeFocus === null) localStorage.setItem(KEY, String(current()));
  }

  grip.addEventListener('dblclick', () => {
    apply(DEFAULT);
    localStorage.setItem(KEY, String(DEFAULT));
  });

  // 窗口变化时重新夹紧，但保留 desired，窗口恢复后自动回到用户设定的宽度
  window.addEventListener('resize', () => {
    root.style.setProperty('--detail-w', clamp(current()) + 'px');
  });

  // 中间表格被拖得极窄时切换成「只有 RowName」的紧凑模式
  const center = document.querySelector('.center');
  if (center && window.ResizeObserver) {
    const NARROW = 320;
    let narrow = false;
    new ResizeObserver(() => {
      const next = center.clientWidth < NARROW;
      if (next === narrow) return;
      narrow = next;
      center.classList.toggle('narrow', narrow);
    }).observe(center);
  }
})();