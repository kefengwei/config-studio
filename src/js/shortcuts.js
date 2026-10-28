/* 配置工作台 · 全局快捷键补全 + 快捷键帮助面板
   本文件最后加载，只处理 app.js / edit.js 没有占用的按键：
     ?  帮助   T  主题   [ ]  切表   R  重载   C  列编辑
     Ctrl+Z 撤销最近一次保存   Ctrl+S（非编辑态）预览并保存
   其余快捷键（/ Ctrl+K Ctrl+F E Delete ↑↓ 等）仍在各自模块里，这里只负责「写进帮助面板」。 */
(function () {
  var GROUPS = [
    { title: '浏览与定位', rows: [
      ['↑ / ↓', '上一条 / 下一条'],
      ['Home / End', '本页首行 / 末行'],
      ['PageUp / PageDown', '翻一屏'],
      ['[ / ]', '上一张 / 下一张配置表'],
      ['R', '重新加载当前表'],
      ['/ | Ctrl K', '全库搜索（命令面板）'],
      ['Ctrl F', '本表内搜索'],
      ['Ctrl Shift F', '筛选左侧配置表'],
    ] },
    { title: '编辑与保存', rows: [
      ['E', '编辑选中行'],
      ['Delete', '删除选中行（先进待保存队列）'],
      ['Ctrl Enter', '应用修改（编辑表单里）'],
      ['Ctrl S', '应用修改（编辑表单里）/ 预览并保存（有待保存改动时）'],
      ['Esc', '取消编辑 / 关闭最上层弹层'],
      ['Ctrl Z', '撤销最近一次保存'],
      ['C', '打开当前表的列编辑'],
    ] },
    { title: '界面', rows: [
      ['T', '切换明暗主题'],
      ['?', '打开 / 关闭这个面板'],
    ] },
  ];

  var mask = null;
  var lastFocus = null;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ' / ' 表示「或」，' | ' 也表示「或」但会显示成「或」字；段内空格拆成多个 kbd */
  function kbdHtml(s) {
    return String(s).split(' | ').map(function (part) {
      return part.split(' / ').map(function (seg) {
        return seg.split(' ').map(function (w) { return '<kbd>' + esc(w) + '</kbd>'; }).join('');
      }).join('<span class="kh-or">/</span>');
    }).join('<span class="kh-or">或</span>');
  }

  function build() {
    mask = document.createElement('div');
    mask.className = 'kh-mask';
    mask.hidden = true;
    var groups = GROUPS.map(function (g) {
      var rows = g.rows.map(function (r) {
        return '<div class="kh-row"><span class="kh-k">' + kbdHtml(r[0]) + '</span><span class="kh-d">' + esc(r[1]) + '</span></div>';
      }).join('');
      return '<div class="kh-group"><div class="kh-gt">' + esc(g.title) + '</div>' + rows + '</div>';
    }).join('');
    mask.innerHTML = '<div class="kh" role="dialog" aria-modal="true" aria-label="键盘快捷键" tabindex="-1">' +
      '<div class="kh-head"><h3>键盘快捷键</h3><span class="kh-hint">在输入框里打字时不触发</span>' +
      '<button class="kh-x" type="button" aria-label="关闭">×</button></div>' +
      '<div class="kh-body">' + groups + '</div>' +
      '<div class="kh-foot">按 <kbd>?</kbd> 或 <kbd>Esc</kbd> 关闭</div>' +
      '</div>';
    document.body.appendChild(mask);
    mask.querySelector('.kh-x').addEventListener('click', close);
    mask.addEventListener('mousedown', function (e) { if (e.target === mask) close(); });
  }

  function open() {
    if (!mask) build();
    if (!mask.hidden) return;
    lastFocus = document.activeElement;
    mask.hidden = false;
    var box = mask.querySelector('.kh');
    if (box) box.focus();
  }

  function close() {
    if (!mask || mask.hidden) return;
    mask.hidden = true;
    if (lastFocus && document.contains(lastFocus)) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }

  function isOpen() { return !!mask && !mask.hidden; }

  function isTyping(el) {
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
  }

  function overlayOpen() {
    return !!document.querySelector('.rp-mask:not([hidden]), .cmdk-mask:not([hidden]), .cfm-mask, .modal-mask, .ce-mask');
  }

  function editing() { return !!document.getElementById('ed-apply'); }

  function status(s) { var el = document.getElementById('status'); if (el) el.textContent = s; }

  /* ---------- 动作 ---------- */

  function switchTable(delta) {
    var list = state.tables || [];
    if (!list.length) return;
    var i = list.findIndex(function (t) { return t.name === state.cur; });
    var next = (i < 0 ? 0 : i + delta + list.length) % list.length;
    if (!list[next] || list[next].name === state.cur) return;
    selectTable(list[next].name);
  }

  async function reloadTable() {
    if (!state.cur) return;
    status('重新加载 ' + state.cur + '…');
    try { await DS.notes(state.cur); } catch (e) {}
    state.tables = Object.values(state.sem.tables).sort(function (a, b) { return b.rowCount - a.rowCount; });
    renderTableList();
    await loadRows();
    status('已重新加载 ' + state.cur);
  }

  async function undoLast() {
    if (EP.pending.size) { await uiAlert('还有未保存的改动', '先把待保存的改动应用或放弃，再撤销上一次保存。'); return; }
    var res = null;
    try { res = await DS.backups(); } catch (e) { await uiAlert('读取备份失败', String(e.message || e)); return; }
    var list = (res && res.backups) || [];
    if (!list.length) { await uiAlert('没有可撤销的保存', '当前工作台还没有产生过备份。'); return; }
    var b = list[0];
    var when = new Date(b.mtime).toLocaleString('zh-CN');
    var ok = await uiConfirm('撤销最近一次保存？', b.id + '\n\n写入时间 ' + when + ' · ' + Math.round(b.size / 1024) + ' KB。被撤销的表会还原成这次保存之前的内容。', { okText: '撤销', danger: true });
    if (!ok) return;
    status('正在撤销…');
    try {
      var r = await DS.undo(b.id);
      await reloadAfterSave([r.table]);
      status('已撤销 ' + r.table + ' 的这次保存');
    } catch (e) {
      status('撤销失败');
      await uiAlert('撤销失败', String(e.message || e));
    }
  }

  function openColumn() {
    if (!state.cur) return;
    var t = state.sem.tables[state.cur];
    if (!t) return;
    var cols = (typeof pickColumns === 'function' ? pickColumns(t) : []) || [];
    var first = cols.find(function (c) { return c.name !== 'RowName'; });
    var field = first ? first.name : (t.fields[1] || t.fields[0] || {}).name;
    if (!field) return;
    CE.open(field, state.filters || []);
  }

  /* ---------- 键盘 ---------- */
  /* 捕获阶段：帮助面板是模态的，打开时先于 app.js / edit.js 吃键，避免一次 Esc 关到别处 */
  document.addEventListener('keydown', function (e) {
    if (e.key === '?') {
      if (isTyping(document.activeElement)) return;
      e.preventDefault();
      if (isOpen()) close(); else open();
      return;
    }
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') return;
    /* 面板打开时其它键一律吞掉，不让底下的界面响应 */
    e.preventDefault();
    e.stopPropagation();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented) return;
    if (isTyping(e.target) || isTyping(document.activeElement)) return;
    if (overlayOpen() || editing()) return;

    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
      if (!EP.pending.size) return;
      e.preventDefault();
      saveAll();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      undoLast();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      if (window.LAYOUT && window.LAYOUT.toggleTheme) window.LAYOUT.toggleTheme();
      return;
    }
    if (e.key === '[') { e.preventDefault(); switchTable(-1); return; }
    if (e.key === ']') { e.preventDefault(); switchTable(1); return; }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); reloadTable(); return; }
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); openColumn(); return; }
  });

  var btn = document.getElementById('help-btn');
  if (btn) btn.addEventListener('click', function () { if (isOpen()) close(); else open(); });
})();
