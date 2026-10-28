/* 引用字段选择器（替代原生 <datalist>）

   为什么要换：<datalist> 的下拉由浏览器绘制，颜色跟系统的 color-scheme 走，
   页面锁成浅色时它仍是黑底；而且无法「打开就滚到当前值」，长表只能手打几个字等它筛。

   用法（事件委托，DOM 被局部重渲染也不用重新绑定）：
     <span class="rp-wrap">
       <input data-rp="Config_TimeControl" value="CommonDaily" />
       <button type="button" class="rp-btn" data-rp-btn>▾</button>
     </span>
   点 ▾ 或在输入框按 ↓ 打开；面板里可搜索、↑↓ 移动、Enter 确认、Esc 关闭。
   选中后写回 input 并派发 input 事件，struct-editor 的写回逻辑能吃上。 */
(function () {
  var mask = null, box = null, qEl = null, listEl = null, nEl = null;
  var all = [], shown = [], cur = -1, want = '', anchor = null, cb = null;
  var emptyText = '没有匹配的行';
  var openedAt = 0;  /* 打开时刻：刚打开时的滚动（把输入框拉回视口、焦点回填）不该把面板关掉 */

  /* 面板数据源：默认「某张表的行」，也可注册自定义源（如执行器名）
     RP.source('actuator', function () { return { label, rows: [{row, notes}], placeholder, empty }; }) */
  var sources = {};

  function escH(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  function ensure() {
    if (mask) return;
    mask = document.createElement('div');
    mask.className = 'rp-mask';
    mask.hidden = true;
    mask.innerHTML = [
      '<div class="rp" role="dialog">',
      '  <div class="rp-bar"><svg class="rp-ico" aria-hidden="true"><use href="#i-search"></use></svg>',
      '    <input class="rp-q" type="text" autocomplete="off" spellcheck="false" placeholder="搜索行名或备注…" />',
      '  </div>',
      '  <div class="rp-list"></div>',
      '  <div class="rp-foot"><span class="rp-n"></span>',
      '    <span class="rp-keys"><kbd>↑↓</kbd><span>选</span><kbd>Enter</kbd><span>打开</span><kbd>Esc</kbd><span>关闭</span></span>',
      '  </div>',
      '</div>'
    ].join('');
    document.body.appendChild(mask);
    box = mask.querySelector('.rp');
    qEl = mask.querySelector('.rp-q');
    listEl = mask.querySelector('.rp-list');
    nEl = mask.querySelector('.rp-n');

    mask.addEventListener('mousedown', function (e) { if (e.target === mask) close(); });
    qEl.addEventListener('input', function () { render(); });
    qEl.addEventListener('keydown', onKey);
    listEl.addEventListener('click', function (e) {
      var it = e.target.closest('.rp-item');
      if (it) pick(Number(it.dataset.i));
    });
    listEl.addEventListener('mousemove', function (e) {
      var it = e.target.closest('.rp-item');
      if (it && Number(it.dataset.i) !== cur) setCur(Number(it.dataset.i), false);
    });
  }

  function filtered() {
    var w = String(qEl.value || '').trim().toLowerCase();
    if (!w) return all;
    return all.filter(function (x) {
      return x.row.toLowerCase().indexOf(w) >= 0 || String(x.notes || '').toLowerCase().indexOf(w) >= 0;
    });
  }

  function render() {
    shown = filtered();
    listEl.innerHTML = shown.length
      ? shown.map(function (x, i) {
          return '<div class="rp-item" role="option" data-i="' + i + '" title="' + escH(x.row) + '">' +
            '<span class="rp-rn">' + escH(x.row) + '</span>' +
            (x.notes ? '<span class="rp-notes">' + escH(x.notes) + '</span>' : '') + '</div>';
        }).join('')
      : '<div class="rp-empty">' + escH(emptyText) + '</div>';
    nEl.textContent = shown.length + ' / ' + all.length + ' 项';

    /* 刚打开（搜索框为空）时定位到当前值并居中；输入过滤后回到第一条 */
    var idx = -1;
    if (!String(qEl.value || '').trim() && want) {
      for (var i = 0; i < shown.length; i++) { if (shown[i].row === want) { idx = i; break; } }
    }
    if (idx < 0 && shown.length) idx = 0;
    cur = idx;
    setCur(idx, true);
  }

  function setCur(i, center) {
    var els = listEl.querySelectorAll('.rp-item');
    for (var k = 0; k < els.length; k++) els[k].classList.toggle('on', Number(els[k].dataset.i) === i);
    cur = i;
    var el = els[i];
    if (!el) return;
    if (center) listEl.scrollTop = el.offsetTop - listEl.clientHeight / 2 + el.offsetHeight / 2;
    else el.scrollIntoView({ block: 'nearest' });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); if (anchor) anchor.focus(); return; }
    if (e.key === 'Enter') { e.preventDefault(); pick(cur); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCur(Math.min(shown.length - 1, cur + 1), false); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCur(Math.max(0, cur - 1), false); return; }
  }

  function pick(i) {
    var it = shown[i];
    if (!it) return;
    var f = cb, a = anchor;
    close();
    if (a) a.focus();
    if (f) f(it.row);
  }

  function close() {
    if (!mask) return;
    mask.hidden = true;
    shown = [];
    cur = -1;
    cb = null;
  }

  function place() {
    if (!anchor) return;
    /* 对齐到「输入框 + 旁边按钮」整体的右边缘，视觉上才像这个控件的下拉 */
    var wrap = anchor.closest('.rp-wrap') || anchor;
    var r = wrap.getBoundingClientRect();
    var pad = 8, gap = 4;
    var W = Math.max(r.width, 280);
    if (W > 360) W = 360;
    if (W > window.innerWidth - pad * 2) W = window.innerWidth - pad * 2;
    /* 右边缘对齐输入框右边缘、向左展开：详情栏很窄，这样不会顶出视口 */
    var left = r.right - W;
    if (left < pad) left = pad;
    if (left + W > window.innerWidth - pad) left = window.innerWidth - pad - W;

    /* 优先向下展开，放不下就向上；两边都紧张时先缩高度，绝不超出视口 */
    var want = Math.min(420, Math.round(window.innerHeight * 0.62));
    var below = window.innerHeight - r.bottom - gap - pad;
    var above = r.top - gap - pad;
    var top, H;
    if (below >= Math.min(want, 200)) {
      H = Math.min(want, below);
      top = r.bottom + gap;
    } else if (above >= Math.min(want, 200)) {
      H = Math.min(want, above);
      top = r.top - gap - H;
    } else {
      H = window.innerHeight - pad * 2;
      top = pad;
    }
    box.style.width = W + 'px';
    box.style.maxHeight = Math.round(H) + 'px';
    box.style.left = Math.round(left) + 'px';
    box.style.top = Math.round(Math.max(pad, top)) + 'px';
  }

  function loadCfg(inp) {
    var srcName = inp.dataset.rpSrc;
    if (srcName && sources[srcName]) {
      var r = sources[srcName]() || {};
      return {
        rows: r.rows || [],
        placeholder: r.placeholder || ('在 ' + (r.label || srcName) + ' 里搜索…'),
        empty: r.empty || '没有匹配项'
      };
    }
    var target = inp.dataset.rp;
    if (!target || typeof DS === 'undefined') return null;
    var d = DS.refs(target);
    var label = (d && d.target) || target;
    return { rows: (d && d.rows) || [], placeholder: '在 ' + label + ' 里搜索…', empty: '没有匹配的行' };
  }

  function openFor(inp) {
    var cfg = loadCfg(inp);
    if (!cfg) return;
    /* 输入框在滚动容器里可能滚出视口（例如靠下的执行器卡片），先把它拉回来再定位 */
    var rb0 = inp.getBoundingClientRect();
    if (rb0.top < 40 || rb0.bottom > window.innerHeight - 40) {
      inp.scrollIntoView({ block: 'center' });
    }
    ensure();
    anchor = inp;
    want = String(inp.value || '');
    cb = function (v) {
      inp.value = v;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    };
    all = cfg.rows;
    emptyText = cfg.empty;
    qEl.value = '';
    qEl.placeholder = cfg.placeholder;
    render();
    openedAt = Date.now();
    mask.hidden = false;
    place();
    /* preventScroll：聚焦本身会滚动页面，而滚动监听会立刻把面板关掉 */
    try { qEl.focus({ preventScroll: true }); } catch (e) { qEl.focus(); }
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-rp-btn]');
    if (!btn) return;
    e.preventDefault();
    var wrap = btn.closest('.rp-wrap');
    var inp = wrap && wrap.querySelector('[data-rp], [data-rp-src]');
    if (inp) openFor(inp);
  });

  document.addEventListener('keydown', function (e) {
    if (mask && !mask.hidden) return;
    var inp = e.target.closest && e.target.closest('[data-rp], [data-rp-src]');
    if (!inp || e.key !== 'ArrowDown') return;
    if (e.altKey) return;
    e.preventDefault();
    openFor(inp);
  });

  /* 给别的模块注册自定义数据源 */
  window.RP = {
    source: function (name, fn) { if (name && typeof fn === 'function') sources[name] = fn; }
  };

  /* 页面滚动/改窗口大小时面板会飘走，直接关掉（简单且不会错位） */
  window.addEventListener('resize', function () { if (mask && !mask.hidden) close(); });
  window.addEventListener('scroll', function (e) {
    if (!mask || mask.hidden) return;
    /* 打开瞬间的滚动事件是上面 scrollIntoView / focus 的余波，忽略 */
    if (Date.now() - openedAt < 250) return;
    /* 面板自己列表的滚动（打开时居中当前值）不能把自己关掉 */
    if (e.target && mask.contains(e.target)) return;
    close();
  }, true);
})();
