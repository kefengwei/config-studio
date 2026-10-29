/* 设置面板（目前只有网络代理）
 *
 * 为什么代理放在这里、而不是让用户自己设系统环境变量：
 *   更新检查和下载都由 Rust 侧发请求。插件虽然有个 proxy 参数，但实测传了不生效（仍然直连），
 *   只能靠 HTTPS_PROXY。用户没法给自己双击打开的 exe 设环境变量，
 *   所以把地址存进 settings.json，Rust 在启动时和保存时各写一次环境变量。
 *
 * 只在桌面版有意义：浏览器版没有 __TAURI__，面板会说明这一点。
 */
(function () {
  const T = window.__TAURI__;
  const isTauri = !!(T && T.core && T.core.invoke);

  function say(s) {
    const el = document.getElementById('status');
    if (el) el.textContent = s;
  }

  async function openSettings() {
    let cur = { proxy: '' };
    if (isTauri) {
      try { cur = (await T.core.invoke('get_settings')) || { proxy: '' }; } catch (e) { /* 读失败按空处理 */ }
    }

    const m = document.createElement('div');
    m.className = 'cfm-mask';
    m.innerHTML =
      '<div class="cfm set-panel" role="dialog" aria-label="设置">' +
        '<div class="cfm-t">设置</div>' +
        '<div class="cfm-body set-body">' +
          '<div class="set-sec">网络</div>' +
          '<label class="set-lab" for="set-proxy">更新代理</label>' +
          '<input id="set-proxy" class="set-inp" type="text" spellcheck="false" autocomplete="off" placeholder="http://127.0.0.1:18089" />' +
          '<p class="set-hint">检查更新、下载安装包都走这个地址（形如 <code>http://主机:端口</code>，也支持 <code>socks5://</code>）。留空表示直连。</p>' +
          '<div class="set-res" id="set-res" hidden></div>' +
          '<p class="set-note" id="set-note"></p>' +
        '</div>' +
        '<div class="cfm-foot">' +
          '<button class="btn" data-x="no" type="button">取消</button>' +
          '<button class="btn primary" data-x="yes" type="button">保存并测试</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);

    const inp = m.querySelector('#set-proxy');
    const res = m.querySelector('#set-res');
    const note = m.querySelector('#set-note');
    const yes = m.querySelector('[data-x="yes"]');
    const no = m.querySelector('[data-x="no"]');
    inp.value = cur.proxy || '';

    if (!isTauri) {
      inp.disabled = true;
      yes.disabled = true;
      note.textContent = '代理只在桌面版（安装版 exe）里生效，浏览器版没有更新功能。';
    } else {
      note.textContent = '改完立即测试：能看到 GitHub 上的版本号就算通。';
    }

    function close() {
      document.removeEventListener('keydown', onKey, true);
      m.remove();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    }
    document.addEventListener('keydown', onKey, true);
    no.onclick = close;
    m.addEventListener('mousedown', function (e) { if (e.target === m) close(); });

    function showRes(kind, text) {
      res.hidden = false;
      res.className = 'set-res ' + kind;
      res.textContent = text;
    }

    yes.onclick = async function () {
      if (!isTauri) return;
      const proxy = inp.value.trim();
      yes.disabled = true;
      no.disabled = true;
      showRes('busy', '正在保存并测试…国内第一次连 GitHub 可能要 30 秒以上，请稍等。');
      try {
        await T.core.invoke('set_settings', { settings: { proxy: proxy } });
      } catch (e) {
        showRes('bad', '保存失败：' + String((e && e.message) || e));
        yes.disabled = false; no.disabled = false;
        return;
      }
      const r = (window.UPD && window.UPD.probe) ? await window.UPD.probe() : { ok: false, error: '更新模块没加载' };
      yes.disabled = false; no.disabled = false;
      if (r.ok) {
        showRes('good', r.version
          ? '连上了：GitHub 上是 ' + r.version + '（当前 ' + (r.current || '—') + '）'
          : '连上了：当前已是最新版本');
        say('代理已保存');
        setTimeout(close, 900);
      } else {
        showRes('bad', '连不上：' + (r.error || '未知错误') + '\n' +
          '设置已经保存了，可以改地址再测，或清空后保存恢复直连。');
        say('代理已保存，但测试失败');
      }
    };

    setTimeout(function () { inp.focus(); inp.select(); }, 0);
  }

  function mount() {
    const btn = document.getElementById('set-btn');
    if (btn) btn.addEventListener('click', openSettings);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  window.SETTINGS = { open: openSettings };
})();
