JSON.stringify({
  semMode: DS.semMode,
  tables: Object.keys(DS.sem.tables).length,
  rows: DS.sem.stats && DS.sem.stats.rows,
  actuators: Object.keys(DS.sem.actuators).length,
  refs: Object.keys(DS.sem.refTargets).length,
  enums: Object.keys(DS.sem.enums).length,
  levelFields: DS.sem.tables.Config_Level ? DS.sem.tables.Config_Level.fields.length : null,
  levelRows: DS.sem.tables.Config_Level ? DS.sem.tables.Config_Level.rowCount : null,
  staleAdded: DS.stale.added.length,
  staleRemoved: DS.stale.removed.length,
  missing: DS.missing.length,
  status: document.querySelector('.status, #status') ? (document.querySelector('.status, #status').textContent || '').slice(0,200) : null,
}, null, 1)