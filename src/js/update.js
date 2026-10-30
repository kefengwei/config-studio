/* 自动更新（只对 Tauri 桌面版生效）
 *
 * 源是 GitHub Release 的 latest.json：
 *   https://github.com/kefengwei/config-studio/releases/latest/download/latest.json
 * 签名校验在 Rust 侧完成（公钥写在 tauri.conf.json 的 plugins.updater.pubkey），
 * 前端只负责「发现新版本 → 让人确认 → 显示进度 → 装完自动重启」。
 *
 * 三条触发路径：
 *   · 启动后 3 秒（静默：没更新什么都不说，不打扰）
 *   · 每 4 小时（应用一直开着时）
 *   · 顶栏按钮（手动：一定有反馈）
 *
 * 浏览器版没有 __TAURI__，整个模块降级成空操作。
 * 下载失败时走兜底：把 GitHub 下载页地址复制给用户，让他自己用浏览器下。
 */
(function () {
  const T = window.__TAURI__;
  if (!T || !T.core || !T.core.invoke) {
    window.UPD = { start: function () {}, check: function () {} };
    return;
  }
  const invoke = T.core.invoke;

  const START_DELAY = 3000;
  const CHECK_TIMEOUT = 30000;
  // 下载总时长上限：国内经代理约 200KB/s，7.7MB 要 40s 以上，默认超时会误报失败
  const DOWNLOAD_TIMEOUT = 600000;
  const INTERVAL_MS = 4 * 60 * 60 * 1000;
  const DL_PAGE = 'https://github.com/kefengwei/config-studio/releases/latest';

  let bar = null;
  let busy = false;       // 下载/安装进行中，挡住重复触发
  let checking = false;   // 检查进行中
  let skipped = null;     // 点过「稍后」的版本，本次会话不再主动弹
  let started = false;

  /* ---------------- 小工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }
  function say(s) {
    const el = document.getElementById('status');
    if (el) el.textContent = s;
  }
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 下面走兜底 */ }
    return false;
  }
  function alertBox(title, text) {
    if (typeof uiAlert === 'function') return uiAlert(title, text);
    window.alert(title + '\n\n' + text);
    return Promise.resolve();
  }
  /* 失败兜底：把下载页地址交到用户手上（方案 B） */
  function offlineHelp(title, detail) {
    const body = detail + '\n\n可能是网络问题（GitHub 在国内经常连不上）。\n' +
      '可以复制下面的地址，用浏览器手动下载最新的安装包：\n' + DL_PAGE;
    if (typeof uiConfirm === 'function') {
      uiConfirm(title, body, { okText: '复制下载链接', cancelText: '关闭' }).then(function (ok) {
        if (!ok) return;
        if (copyText(DL_PAGE)) say('下载链接已复制，粘到浏览器里打开');
        else alertBox('复制失败', '请手动复制这个地址：\n' + DL_PAGE);
      });
    } else {
      alertBox(title, body);
    }
  }

  /* ---------------- 提示条 ---------------- */
  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'upd-bar';
    bar.id = 'upd-bar';
    bar.hidden = true;
    bar.innerHTML =
      '<svg class="upd-ic" aria-hidden="true"><use href="#i-download"></use></svg>' +
      '<div class="upd-txt"><b class="upd-title"></b><span class="upd-sub"></span></div>' +
      '<button class="btn primary upd-go" type="button">立即更新</button>' +
      '<button class="btn upd-skip" type="button">稍后</button>';
    document.body.appendChild(bar);
    bar.querySelector('.upd-skip').addEventListener('click', function () {
      if (busy) return;
      hideBar();
    });
    bar.querySelector('.upd-go').addEventListener('click', function () {
      if (bar._meta) runUpdate(bar._meta);
    });
    return bar;
  }
  function setBar(title, sub) {
    const el = ensureBar();
    el.querySelector('.upd-title').textContent = title;
    el.querySelector('.upd-sub').textContent = sub || '';
    el.hidden = false;
  }
  function hideBar() {
    if (bar) { bar.hidden = true; bar._meta = null; }
  }
  function setButtons(disabled) {
    const el = ensureBar();
    el.querySelector('.upd-go').disabled = !!disabled;
    el.querySelector('.upd-skip').disabled = !!disabled;
  }

  /* ---------------- 检查 ---------------- */
  // 国内连 GitHub 抖一下很常见，失败后自动再试一次（多等 1.2 秒，成功率明显上升）
  async function invokeCheck(quiet) {
    try {
      return await invoke('plugin:updater|check', { timeout: CHECK_TIMEOUT });
    } catch (e) {
      // 静默检查（启动 3 秒后那次）和设置面板的探测失败都不写状态栏：
      // 国内直连 GitHub 本来就会失败，每次启动都在底部挂一句「检查失败」很吵。
      if (!quiet) say('第一次检查失败，正在重试…');
      await new Promise(function (r) { setTimeout(r, 1200); });
      return await invoke('plugin:updater|check', { timeout: CHECK_TIMEOUT });
    }
  }

  async function check(manual) {
    if (busy || checking) return;
    checking = true;
    if (manual) say('正在检查更新…');
    let meta = null;
    try {
      meta = await invokeCheck(!manual);
    } catch (e) {
      checking = false;
      if (manual) {
        say('检查更新失败');
        offlineHelp('检查更新失败', 'GitHub 那边没回话：\n' + String((e && e.message) || e));
      }
      return;
    }
    checking = false;

    if (!meta) {
      if (manual) {
        say('已经是最新版本');
        alertBox('已是最新版本', '当前版本就是 GitHub 上最新的那一版，不需要更新。');
      }
      return;
    }
    if (skipped === meta.version) return;   // 用户说过「稍后」
    bar = ensureBar();
    bar._meta = meta;
    setBar('发现新版本 ' + meta.version,
      '当前 ' + (meta.currentVersion || '—') +
      (meta.date ? ' · 发布于 ' + String(meta.date).slice(0, 10) : '') +
      ' · 装完会自动重启');
    setButtons(false);
    if (manual) say('发现新版本 ' + meta.version);
  }

  /* ---------------- 下载 + 安装 ---------------- */
  async function runUpdate(meta) {
    if (busy) return;
    busy = true;
    setButtons(true);

    let total = 0;
    let got = 0;
    let lastPct = -1;
    const ch = new T.core.Channel();
    ch.onmessage = function (ev) {
      const d = (ev && ev.data) || {};
      if (ev.event === 'Started') {
        total = d.contentLength || 0;
        setBar('正在下载…', total ? '0 / ' + mb(total) : '');
      } else if (ev.event === 'Progress') {
        got += d.chunkLength || 0;
        const pct = total ? Math.min(100, Math.round((got / total) * 100)) : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          setBar('正在下载 ' + pct + '%', total ? mb(got) + ' / ' + mb(total) : mb(got));
        }
      } else if (ev.event === 'Finished') {
        setBar('下载完成，正在安装…', '应用会自动关闭并重启，请稍等');
      }
    };

    try {
      await invoke('plugin:updater|download_and_install', {
        rid: meta.rid,
        onEvent: ch,
        timeout: DOWNLOAD_TIMEOUT,
        restartAfterInstall: true
      });
      // Windows 上走到这里一般安装器已经拉起来了，进程随后退出；没退出也给个说明
      setBar('安装已启动', '如果窗口没有自动关闭，请手动退出再打开工作台');
      busy = false;
      setButtons(false);
    } catch (e) {
      busy = false;
      hideBar();
      offlineHelp('更新失败', '下载或安装没成功：\n' + String((e && e.message) || e));
    }
  }

  /* ---------------- 启动 ---------------- */
  function start() {
    if (started) return;
    started = true;
    const bar0 = ensureBar();
    bar0.querySelector('.upd-skip').addEventListener('click', function () {
      const v = bar0._meta && bar0._meta.version;
      if (v) skipped = v;
    });
    const btn = document.getElementById('upd-btn');
    if (btn) btn.addEventListener('click', function () { check(true); });
    setTimeout(function () { check(false); }, START_DELAY);
    setInterval(function () { check(false); }, INTERVAL_MS);
  }

  /* 给设置面板用的连通性探测：不弹窗、不写状态栏，只回结果。
     设置面板保存代理后立刻调它一次，用户能当场知道通没通。 */
  async function probe() {
    try {
      // 复用带重试的版本：国内第一次连 GitHub 常常要 20-40 秒，
      // 单发一次 15 秒超时会把「能通但慢」误报成失败。
      const meta = await invokeCheck(true);
      return { ok: true, version: meta ? meta.version : null, current: meta ? meta.currentVersion : null };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  window.UPD = {
    start: start,
    check: function () { return check(true); },
    probe: probe,
    get busy() { return busy; }
  };
})();

