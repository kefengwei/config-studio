/* 配置工作台 · 从 json-schemas 现算语义层
 * 和 scripts/build-semantics.mjs 是同一套规则，只是输入换成运行时数据：
 *   - schema 来自配置仓库的 json-schemas/（Rust / PowerShell 一次读全，前端 parse）
 *   - 数据统计（引用目标、行数、注释率、执行器参数）来自前端扫描 configs/
 * 这样后端改字段只需重导 schema 并提交，工作台不必重新构建、也不必重新发版。
 */
const SFS = (() => {
  const HAN = /[\u4e00-\u9fa5]/;
  const POLY_BASES = new Set([
    'ActuatorInstanceData',
    'ProgressTrackerInstanceData',
    'StatisticDefineInstanceData',
    'ExtraActionDefineInstanceData',
  ]);
  const UNIT_HINTS = {
    Count: { unit: '个', note: '负数=扣除' },
    Probability: { unit: '万分比', note: '10000 = 100%' },
    Weight: { unit: '权重', note: '相对权重,非百分比' },
    Order: { unit: '序号', note: '' },
    Grade: { unit: '阶', note: '' },
    Level: { unit: '级', note: '' },
    RecommendedCombatPower: { unit: '战力', note: '' },
    StandardCoinBase: { unit: '金币', note: '' },
    RequiredValue: { unit: '', note: '' },
    Value: { unit: '', note: '可为负' },
    Amount: { unit: '', note: '' },
  };
  const SKIP_IMPLICIT = new Set(['Name', 'Type', 'Desc', 'Description', 'Notes', 'Title', 'Icon', 'Path', 'Key', 'Value', 'Comment', 'Text', 'Url', 'Color', 'Sound', 'Effect', 'Prefab', 'Anim', 'Bundle', 'Address', 'Group', 'Category', 'Tag', 'RowName', 'Id', 'Ids', 'Channel', 'DataType']);

  /* schema 里定义了 enum 的 definition：{ 枚举名: { '0': '中文' } } */
  function enumsFromSchemas(schemas) {
    const out = {};
    for (const sc of Object.values(schemas)) {
      for (const [dn, dv] of Object.entries(sc.definitions || {})) {
        if (!dv || !Array.isArray(dv.enum)) continue;
        const names = dv['x-enumNames'] || [];
        const descs = dv.enumDescriptions || {};
        const map = {};
        dv.enum.forEach((v, i) => { map[String(v)] = descs[String(v)] || names[i] || String(v); });
        if (!out[dn]) out[dn] = map;
      }
    }
    return out;
  }

  /* description 里的目标提示，如「灵宠行名称(Config_SpiritPet.RowName)」 */
  function hintTarget(desc, schemas) {
    if (!desc) return null;
    const m = desc.match(/Config_([A-Za-z0-9_]+)\.RowName/) || desc.match(/Config_([A-Za-z0-9_]+)\s*中/);
    if (!m) return null;
    const t = 'Config_' + m[1];
    return schemas[t] ? t : null;
  }

  function classify(p, defs, enumByDef) {
    if (!p) return { kind: 'any' };
    if (p['$ref']) {
      const ref = p['$ref'].split('/').pop();
      const target = defs[ref];
      if (target && target.enum) return { kind: 'enum', enum: ref, values: enumByDef[ref] || null, desc: p.description || target.description || '' };
      if (target && target.oneOf) return { kind: 'poly', def: ref, desc: p.description || '' };
      return { kind: 'object', def: ref, desc: p.description || '' };
    }
    if (p.oneOf) {
      /* 内联 oneOf 常常只是外层包一层、里面一个 $ref：
         Config_Task.ProgressTracker = { oneOf:[{ $ref:'#/definitions/ProgressTrackerInstanceData' }] }
         只记 variants 会丢掉容器名，前端就分不出「进度追踪器」和「执行器」。 */
      const refs = p.oneOf.map((x) => (x && x['$ref'] ? x['$ref'].split('/').pop() : null)).filter(Boolean);
      const polyDef = refs.find((r) => defs[r] && defs[r].oneOf) || undefined;
      return { kind: 'poly', ...(polyDef ? { def: polyDef } : {}), desc: p.description || '', variants: p.oneOf.length };
    }
    if (p.type === 'array') {
      const it = p.items || {};
      if (it['$ref']) {
        const ref = it['$ref'].split('/').pop();
        if (ref === 'ActuatorInstanceData') return { kind: 'actuators', desc: p.description || '' };
        if (enumByDef[ref]) return { kind: 'enumarray', enum: ref, desc: p.description || '' };
        return { kind: 'objectarray', def: ref, desc: p.description || '' };
      }
      return { kind: 'primarray', desc: p.description || '' };
    }
    if (p.type === 'integer' || p.type === 'number') return { kind: 'number', desc: p.description || '', format: p.format || null };
    if (p.type === 'boolean') return { kind: 'bool', desc: p.description || '' };
    if (p.type === 'string') {
      if (p.format === 'duration') return { kind: 'duration', desc: p.description || '' };
      if (p.format === 'date-time') return { kind: 'datetime', desc: p.description || '' };
      return { kind: 'text', desc: p.description || '', format: p.format || null };
    }
    if (Array.isArray(p.type)) return { kind: 'nullable', types: p.type, desc: p.description || '' };
    if (p.const) return { kind: 'const', value: p.const, desc: p.description || '' };
    return { kind: 'any', desc: p.description || '' };
  }

  /* schema 里「Name 是 const + 有 JsonInput」的四个多态容器，全部收集，按 base 区分 */
  function collectActuators(schemas, hint) {
    const out = {};
    function walk(node, table, base) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach((x) => walk(x, table, base));
      const np = node.properties && node.properties.Name;
      if (np && np.const && node.properties.JsonInput) {
        const name = np.const;
        if (!out[name]) {
          const params = {};
          for (const [pn, pv] of Object.entries(node.properties.JsonInput.properties || {})) {
            params[pn] = { type: pv.type || 'any', desc: pv.description || '', target: hint(pv.description) };
          }
          out[name] = { name, base: base || '', desc: np.description || '', params, definedIn: table };
        }
      }
      for (const v of Object.values(node)) walk(v, table, base);
    }
    for (const [table, sc] of Object.entries(schemas)) {
      for (const [dn, dv] of Object.entries(sc.definitions || {})) walk(dv, table, POLY_BASES.has(dn) ? dn : '');
    }
    return out;
  }

  /* 用数据里的实际取值推断每个 *RowName 字段指向哪张表（命中率最高的那张） */
  function buildRefTargets(agg, baseTables, schemas) {
    const refTargets = {};
    const bestOf = (vals) => {
      let best = null;
      for (const t of baseTables) {
        const idx = agg.rowIndex[t];
        if (!idx || !idx.size) continue;
        let hit = 0;
        for (const v of vals) if (idx.has(v)) hit++;
        const rate = hit / vals.length;
        if (!best || rate > best.rate || (rate === best.rate && hit > best.hit)) best = { target: t, rate, hit };
      }
      return best;
    };
    for (const [field, set] of Object.entries(agg.refValues)) {
      const vals = [...set];
      if (!vals.length) continue;
      const best = bestOf(vals);
      const guess = 'Config_' + field.replace(/RowName$/, '');
      let reason = 'data';
      if (schemas[guess]) reason = 'naming';
      refTargets[field] = {
        target: best && best.rate > 0.5 ? best.target : guess,
        confidence: best ? +best.rate.toFixed(3) : 0,
        hits: best ? best.hit : 0,
        total: vals.length,
        reason: reason,
        sample: vals.slice(0, 5),
      };
    }
    for (const [field, set] of Object.entries(agg.strValues)) {
      if (refTargets[field]) continue;
      if (set.size < 5 || set.size > 3000) continue;
      const vals = [...set];
      const best = bestOf(vals);
      if (best && best.rate >= 0.95) {
        refTargets[field] = { target: best.target, confidence: +best.rate.toFixed(3), hits: best.hit, total: vals.length, reason: 'implicit', sample: vals.slice(0, 5) };
      }
    }
    return refTargets;
  }

  /* 执行器参数 → 目标表：schema 里的 description 提示优先，其次按数据命中率（>=0.8） */
  function refineParamTargets(actuators, agg, baseTables) {
    for (const [actName, params] of Object.entries(agg.paramValues || {})) {
      const meta = actuators[actName];
      if (!meta) continue;
      for (const [pn, set] of Object.entries(params)) {
        if (meta.params[pn] && meta.params[pn].target) continue;
        if (!/RowName$/.test(pn) && set.size < 3) continue;
        const vals = [...set];
        if (vals.length < 3) continue;
        let best = null;
        for (const t of baseTables) {
          const idx = agg.rowIndex[t];
          if (!idx || !idx.size) continue;
          let hit = 0;
          for (const v of vals) if (idx.has(v)) hit++;
          const rate = hit / vals.length;
          if (!best || rate > best.rate) best = { target: t, rate, hit };
        }
        if (best && best.rate >= 0.8) {
          meta.params[pn] = { ...(meta.params[pn] || {}), target: best.target, confidence: +best.rate.toFixed(2), samples: vals.length };
        }
      }
    }
  }

  /* 主入口：schemas + 数据聚合 → 与 semantics.json 同结构 */
  function build(opts) {
    const schemas = opts.schemas || {};
    const baseTables = (opts.baseTables || []).filter((t) => schemas[t] || (opts.agg.tableMeta || {})[t]);
    const agg = opts.agg || {};
    const enumByDef = enumsFromSchemas(schemas);
    const hint = (d) => hintTarget(d, schemas);
    const actuators = collectActuators(schemas, hint);
    refineParamTargets(actuators, agg, baseTables);
    const refTargets = buildRefTargets(agg, baseTables, schemas);

    const tables = {};
    for (const t of baseTables) {
      const sc = schemas[t];
      const def = sc && sc.definitions ? sc.definitions[t] : null;
      const meta = (agg.tableMeta || {})[t] || { count: 0, notesFilled: 0, keys: null };
      const fields = [];
      if (def && def.properties) {
        for (const [name, p] of Object.entries(def.properties)) {
          const c = classify(p, sc.definitions || {}, enumByDef);
          if (name !== 'RowName' && refTargets[name]) {
            fields.push({ name, kind: 'ref', target: refTargets[name].target, confidence: refTargets[name].confidence, hits: refTargets[name].hits, total: refTargets[name].total, implicit: refTargets[name].reason === 'implicit', desc: p.description || '' });
            continue;
          }
          if (UNIT_HINTS[name] && c.kind === 'number') { c.unit = UNIT_HINTS[name].unit; c.note = UNIT_HINTS[name].note; }
          fields.push({ name, ...c });
        }
      }
      const extraKeys = [];
      if (meta.keys) for (const k of meta.keys) if (!fields.some((f) => f.name === k)) extraKeys.push(k);
      tables[t] = {
        name: t,
        rowCount: meta.count || 0,
        notesFilled: meta.notesFilled || 0,
        notesRate: meta.count ? Math.round((meta.notesFilled / meta.count) * 100) : 0,
        fields: fields,
        extraKeys: extraKeys,
        increments: (agg.increments || {})[t] || null,
        hasSchema: !!def,
      };
    }

    const actList = Object.values(actuators);
    return {
      generatedAt: new Date().toISOString(),
      source: { mode: 'schema', schemaDir: 'json-schemas' },
      stats: {
        tables: baseTables.length,
        rows: baseTables.reduce((n, t) => n + (((agg.tableMeta || {})[t] || {}).count || 0), 0),
        actuators: actList.filter((a) => a.base === 'ActuatorInstanceData').length,
        polyEntries: actList.filter((a) => a.base !== 'ActuatorInstanceData').length,
        refFields: Object.keys(refTargets).length,
        enums: Object.keys(enumByDef).length,
        enumsWithChinese: Object.values(enumByDef).filter((m) => Object.values(m).some((l) => HAN.test(l))).length,
      },
      enums: enumByDef,
      refTargets: refTargets,
      actuators: actuators,
      tables: tables,
    };
  }

  return { build: build };
})();
window.SFS = SFS;