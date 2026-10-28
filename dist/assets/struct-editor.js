/* 配置工作台 · 结构化编辑器
 * 把 JSON 值渲染成可以点的控件树，替代「让策划直接改 JSON」：
 *   {Name, JsonInput}  执行器  → 类型输入 + 参数输入
 *   数组                       → 条目列表，可增删
 *   对象                       → 键值行，递归
 *   标量                       → 输入框 / 布尔下拉
 *
 * 数据流：draft（纯 JS 对象）是唯一真源，DOM 只是投影。
 * 所有改动按 data-p 里的路径写回 draft，增删后只重渲染当前字段。
 */
const SE = (() => {
  const escA = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const P = (path) => "'" + JSON.stringify(path).replace(/'/g, "\\'") + "'";

  /* ---------- 数据存取 ---------- */
  function getAt(root, path) {
    let cur = root;
    for (const k of path) {
      if (cur == null) return undefined;
      cur = cur[k];
    }
    return cur;
  }
  function setAt(root, path, v) {
    let cur = root;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = typeof path[i + 1] === 'number' ? [] : {};
      cur = cur[k];
    }
    cur[path[path.length - 1]] = v;
  }
  function delAt(root, path) {
    const parent = getAt(root, path.slice(0, -1));
    if (!parent) return;
    const last = path[path.length - 1];
    if (Array.isArray(parent)) parent.splice(last, 1);
    else delete parent[last];
  }

  /* ---------- 类型判断 ---------- */
  const isActuator = (v) => !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof v.Name === 'string' && 'JsonInput' in v;
  const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  function supports(field) {
    return ['actuators', 'objectarray', 'poly', 'object', 'primarray'].includes(field.kind);
  }

  function normalize(field, v) {
    const empty = (field.kind === 'object' || field.kind === 'poly') ? {} : [];
    if (v === undefined || v === null) return empty;
    return JSON.parse(JSON.stringify(v));
  }

  /* ---------- 中文标签 ---------- */
  /* 高频执行器中文名：类型定义里只有英文 desc（类名拆词），中文只到参数级。
     实测全库 21931 次调用 / 84 个执行器，下面 9 个覆盖 96.1%，长尾回落英文 desc。 */
  const ACT_CN = {
    AddCatalogItem: '发放物品',
    WeightRandom: '按权重随机抽取',
    Statistic: '累计统计进度',
    AddEquipment: '发放装备',
    AddPlayerAttribute: '增加玩家属性',
    AddEngagementValue: '增加活跃值',
    ForceAddStatisticValue: '直接设置统计值',
    GenerateGem: '生成宝石',
    BuyGiftPack: '发放礼包',
    UnlockPlayerCustom: '解锁个性化',
    ActivateTask: '激活任务',
    UpdateActuatorModifyValue: '修改执行器参数值',
    UpdateTalentStageLimit: '提升天赋阶段上限',
    UnlockGameFeature: '解锁玩法',
    UpdateEquipmentLevelLimit: '提升装备等级上限',
    AddGuildContribution: '增加公会贡献',
    PityGacha: '保底抽卡',
    UpdateGuide: '推进引导',
    ArenaRank: '竞技场排名',
    ServerUptime: '服务器运行时长',
  };

  function actLabel(name, fallback) {
    return ACT_CN[name] || fallback || '';
  }

  function keyLabel(k) {
    if (typeof KEY_CN !== 'undefined' && KEY_CN[k]) return KEY_CN[k];
    return k.replace(/RowName$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  /* ---------- 执行器名面板：注册成 ref-picker 的数据源 ---------- */
  function actuatorRows() {
    const rows = Object.entries(state.sem.actuators).map(([name, a]) => {
      const cn = ACT_CN[name] || '';
      const desc = (a && a.desc) || '';
      return { row: name, notes: cn && desc ? cn + ' · ' + desc : (cn || desc) };
    });
    rows.sort((x, y) => x.row.localeCompare(y.row));
    return rows;
  }
  if (window.RP) {
    window.RP.source('actuator', () => ({
      label: '执行器',
      rows: actuatorRows(),
      placeholder: '搜索执行器名或中文说明…',
      empty: '没有匹配的执行器，可直接输入名称',
    }));
  }

  /* ---------- 标量输入 ---------- */
  function primInput(v, path, keyHint) {
    const p = 'data-p=' + P(path);
    if (typeof v === 'boolean') {
      return '<select class="ed-ctl se-in" ' + p + ' data-t="bool">' +
        '<option value="true"' + (v ? ' selected' : '') + '>是</option>' +
        '<option value="false"' + (v ? '' : ' selected') + '>否</option></select>';
    }
    if (typeof v === 'number') {
      return '<input class="ed-ctl se-in" type="number" step="any" ' + p + ' data-t="num" value="' + v + '" />';
    }
    if (v === null || v === undefined) {
      const it = keyHint && /Count|Num|Level|Grade|Value|Probability|Weight/.test(keyHint) ? 'number' : 'text';
      return '<input class="ed-ctl se-in" type="' + it + '" ' + p + ' data-t="' + (it === 'number' ? 'num' : 'raw') +
        '" value="" placeholder="未设置" />';
    }
    return '<input class="ed-ctl se-in" ' + p + ' data-t="str" value="' + escA(v) + '" />';
  }

  /* ---------- 执行器 ---------- */
  const TYPE_NULL = (t) => Array.isArray(t) ? t.includes('null') : t === 'null';

  function defaultParams(name, old) {
    const meta = state.sem.actuators[name];
    if (!meta) return isPlainObj(old) ? old : {};
    const out = {};
    for (const [k, def] of Object.entries(meta.params || {})) {
      if (old && old[k] !== undefined) out[k] = old[k];
      else if (TYPE_NULL(def.type)) out[k] = null;
      else if (def.type === 'integer' || def.type === 'number') out[k] = 0;
      else if (def.type === 'boolean') out[k] = false;
      else out[k] = '';
    }
    return out;
  }

  function actHtml(a, path) {
    const meta = state.sem.actuators[a.Name];
    const p = isPlainObj(a.JsonInput) ? a.JsonInput : {};
    const defs = (meta && meta.params) || {};
    const keys = [...Object.keys(defs), ...Object.keys(p).filter((k) => !defs[k])];
    const params = keys.length
      ? keys.map((k) => paramHtml(k, p[k], defs[k], path.concat('JsonInput', k))).join('')
      : '<div class="se-none">这个执行器没有参数</div>';
    return '<div class="se-act">' +
      '<div class="se-act-top">' +
        '<span class="rp-wrap">' +
          '<input class="ed-ctl se-act-name" data-act="actname" data-rp-src="actuator" data-p=' + P(path.concat('Name')) +
            ' value="' + escA(a.Name || '') + '" placeholder="执行器名，例如 AddCatalogItem" />' +
          '<button type="button" class="rp-btn" data-rp-btn title="从已有执行器里选">▾</button>' +
        '</span>' +
        '<div class="se-act-desc" title="' + escA((meta && meta.desc) || '') + '">' +
          (meta ? escA(actLabel(a.Name, meta.desc)) : '<span class="se-warn">未知执行器</span>') + '</div>' +
      '</div>' +
      '<div class="se-params">' + params + '</div></div>';
  }

  function paramHtml(k, v, def, path) {
    const label = def && def.desc ? shortDesc(def.desc, 20) : keyLabel(k);
    let ctrl;
    if (def && def.target) {
      ctrl = '<span class="rp-wrap">' +
        '<input class="ed-ctl se-in" data-p=' + P(path) + ' data-t="str" data-rp="' + escA(def.target) +
          '" value="' + escA(v == null ? '' : v) + '" placeholder="' + escA(def.target) + '" />' +
        '<button type="button" class="rp-btn" data-rp-btn title="从 ' + escA(def.target) + ' 里选一行">▾</button>' +
        '</span>';
    } else {
      ctrl = primInput(v, path, k);
    }
    return '<label class="se-p"><span class="se-pk" title="' + escA(k + (def && def.target ? ' → ' + def.target : '')) + '">' +
      escA(label) + '</span>' + ctrl + '</label>';
  }

  /* ---------- 递归渲染 ---------- */
  function html(v, path) {
    if (Array.isArray(v)) return arrHtml(v, path);
    if (isActuator(v)) return actHtml(v, path);
    if (isPlainObj(v)) return objHtml(v, path);
    return '<div class="se-prim">' + primInput(v, path, path[path.length - 1]) + '</div>';
  }

  function arrHtml(arr, path) {
    if (!arr.length) return emptyHtml(path, '还没配置');
    if (arr.every((x) => x === null || typeof x !== 'object')) {
      return '<input class="ed-ctl se-primarr" data-t="primarr" data-p=' + P(path) +
        ' value="' + escA(arr.join(', ')) + '" />';
    }
    return '<div class="se-list">' +
      arr.map((el, i) => '<div class="se-item">' +
        '<button class="se-x" data-act="del" data-p=' + P(path.concat(i)) + ' title="删除这一条">×</button>' +
        html(el, path.concat(i)) + '</div>').join('') +
      '<button class="se-add" data-act="add" data-p=' + P(path) + '>+ 添加</button></div>';
  }

  function objHtml(obj, path) {
    const keys = Object.keys(obj);
    if (!keys.length) return emptyHtml(path, '空对象');
    return '<div class="se-obj">' + keys.map((k) => {
      const v = obj[k];
      const cp = path.concat(k);
      const nested = Array.isArray(v) || isPlainObj(v);
      return '<div class="se-row' + (nested ? ' se-block' : '') + '">' +
        '<div class="se-k">' + escA(keyLabel(k)) + '<i>' + escA(k) + '</i></div>' +
        '<div class="se-v">' + (nested ? html(v, cp) : primInput(v, cp, k)) + '</div></div>';
    }).join('') + '</div>';
  }

  function emptyHtml(path, tip) {
    return '<div class="se-empty"><span>' + escA(tip) + '</span>' +
      '<button class="se-add" data-act="add" data-p=' + P(path) + '>+ 添加</button></div>';
  }

  /* ---------- 新条目模板：从当前页同字段的其它行抄形状 ---------- */
  const tplCache = new Map();

  function blankCopy(v) {
    if (Array.isArray(v)) return [];
    if (isActuator(v)) return { Name: '', JsonInput: {} };
    if (isPlainObj(v)) {
      const o = {};
      for (const k of Object.keys(v)) o[k] = blankCopy(v[k]);
      return o;
    }
    if (typeof v === 'number') return 0;
    if (typeof v === 'boolean') return false;
    return '';
  }

  /* 按完整路径取模板，而不是只按字段名。
     Task.Rewards 的形状是 [{RequiredValue, Rewards:[执行器...]}]，内外两层数组同名，
     只按字段名取模板会把外层阶梯 {RequiredValue,Rewards} 当成内层执行器，
     于是每点一次「+ 添加」就多套一层 RequiredValue/Rewards。
     这里把路径里的数字下标当作「该层数组的任意元素」，逐行下钻到目标位置再抄形状。 */
  function templateFor(path) {
    const key = JSON.stringify(path);
    if (tplCache.has(key)) return tplCache.get(key);
    let tpl = null;
    for (const r of (state.rows || [])) {
      let cur = r;
      let ok = true;
      for (const seg of path) {
        if (cur === null || cur === undefined) { ok = false; break; }
        if (typeof seg === 'number') {
          if (!Array.isArray(cur) || !cur.length) { ok = false; break; }
          cur = cur[0];
        } else if (typeof cur === 'object') {
          cur = cur[seg];
        } else { ok = false; break; }
      }
      if (!ok || cur === null || cur === undefined) continue;
      if (Array.isArray(cur) && cur.length) { tpl = blankCopy(cur[0]); break; }
      if (isPlainObj(cur) && Object.keys(cur).length) { tpl = blankCopy(cur); break; }
    }
    tplCache.set(key, tpl);
    return tpl;
  }

  /* ---------- 对外 ---------- */
  return {
    supports,
    normalize,

    /** 字段级渲染：外面包一层 data-se-field，方便局部重渲染 */
    fieldHtml(field, value) {
      return '<div class="se" data-se-field="' + escA(field.name) + '">' + html(value, [field.name]) + '</div>';
    },

    /** 把事件委托挂到表单根上，draft.values 是 { 字段名: 值 } */
    bind(formEl, draft) {
      tplCache.clear();
      const rerender = (field) => {
        const box = formEl.querySelector('[data-se-field="' + field + '"]');
        if (!box) return;
        box.innerHTML = html(getAt(draft.values, [field]), [field]);
      };

      const write = (el) => {
        if (!el.dataset.p) return false;
        const path = JSON.parse(el.dataset.p);
        if (el.dataset.t === 'primarr') {
          setAt(draft.values, path, el.value.split(',').map((s) => s.trim()).filter((s) => s !== ''));
          return true;
        }
        if (!el.classList.contains('se-in') && el.dataset.act !== 'actname') return false;
        let v = el.value;
        if (el.dataset.t === 'num') v = el.value === '' ? null : Number(el.value);
        else if (el.dataset.t === 'bool') v = el.value === 'true';
        setAt(draft.values, path, v);
        return true;
      };

      formEl.addEventListener('input', (e) => {
        const el = e.target;
        if (el.classList && el.classList.contains('se-in') && el.dataset.t !== 'bool') write(el);
      });

      formEl.addEventListener('change', (e) => {
        const el = e.target;
        if (!el.dataset || !el.dataset.p) return;
        if (el.dataset.act === 'actname') {
          const path = JSON.parse(el.dataset.p);
          const actPath = path.slice(0, -1);
          const act = getAt(draft.values, actPath);
          if (!act) return;
          act.Name = el.value;
          act.JsonInput = defaultParams(el.value, act.JsonInput);
          rerender(path[0]);
          return;
        }
        write(el);
      });

      formEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act="del"], [data-act="add"]');
        if (!btn) return;
        e.preventDefault();
        const path = JSON.parse(btn.dataset.p);
        const field = path[0];
        if (btn.dataset.act === 'del') {
          delAt(draft.values, path);
        } else {
          const cur = getAt(draft.values, path);
          const tpl = templateFor(path);
          if (Array.isArray(cur)) cur.push(tpl ? JSON.parse(JSON.stringify(tpl)) : { Name: '', JsonInput: {} });
          else {
            // 空对象：用同字段模板整体填充
            setAt(draft.values, path, tpl ? JSON.parse(JSON.stringify(tpl)) : { Name: '', JsonInput: {} });
          }
        }
        rerender(field);
      });
    },
  };
})();
