/* 配置工作台 · Tauri 后端
 *
 * 职责对等原来的 server.ps1，但用进程内命令替代 HTTP：
 *   读原文 / 写原文（带自动备份）/ 列备份 / 撤销 / 列配置表 / 配置目录状态 / 最近目录历史
 * 解析、校验、diff 仍然全部在前端，后端只搬字节。
 */
mod git;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const MAX_RECENT: usize = 8;
const CONFIG_PREFIX: &str = "Config_";

struct AppState {
  root: Mutex<Option<PathBuf>>,
}

impl Default for AppState {
  fn default() -> Self {
    Self { root: Mutex::new(None) }
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PingInfo {
  config_dir: String,
  version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TableInfo {
  name: String,
  size: u64,
  mtime: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
  backup: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupInfo {
  id: String,
  size: u64,
  mtime: u64,
  /// 从 id 前缀还原出来的写入时间（ISO 8601）。mtime 不可靠：
  /// fs::copy 会保留源文件的 mtime，导致备份的 mtime 早于备份动作本身。
  created_at: String,
}

/// 把 2026-10-28T02-32-43-863Z--Config_X.json 的前缀还原成 2026-10-28T02:32:43.863Z
fn id_created_at(id: &str) -> String {
  let head = id.split("--").next().unwrap_or("").trim_end_matches('Z');
  if let Some((d, t)) = head.split_once('T') {
    let p: Vec<&str> = t.split('-').collect();
    if p.len() == 4 {
      return format!("{}T{}:{}:{}.{}Z", d, p[0], p[1], p[2], p[3]);
    }
  }
  String::new()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UndoResult {
  backup: String,
  table: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigInfo {
  path: String,
  name: String,
  tables: usize,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RecentDir {
  path: String,
  name: String,
  tables: usize,
  last: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentOut {
  path: String,
  name: String,
  tables: usize,
  last: u64,
  exists: bool,
}

/* ---------------- 小工具 ---------------- */

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn stamp() -> String {
  chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ").to_string()
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
  meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 传入的可能是仓库根，也可能是 configs 目录本身。
fn configs_of(root: &Path) -> PathBuf {
  let inner = root.join("configs");
  if inner.is_dir() { inner } else { root.to_path_buf() }
}

fn count_configs(dir: &Path) -> usize {
  let Ok(rd) = fs::read_dir(dir) else { return 0 };
  rd.filter_map(|e| e.ok())
    .filter(|e| {
      let name = e.file_name().to_string_lossy().to_lowercase();
      name.ends_with(".json") && e.file_name().to_string_lossy().starts_with(CONFIG_PREFIX)
    })
    .count()
}

/// 校验目录，返回 (仓库根, 表数量)
fn validate_dir(p: &Path) -> Result<(PathBuf, usize), String> {
  if !p.is_dir() {
    return Err(format!("不是一个文件夹：{}", p.display()));
  }
  let n = count_configs(&configs_of(p));
  if n == 0 {
    return Err(format!(
      "这个文件夹里没有配置文件。\n期望的结构是 <你选的目录>/configs/{}*.json",
      CONFIG_PREFIX
    ));
  }
  Ok((p.to_path_buf(), n))
}

/// 只允许单层文件名，挡住 ../ 之类的穿越
fn safe_name(name: &str) -> Result<String, String> {
  let n = if name.to_lowercase().ends_with(".json") {
    name.to_string()
  } else {
    format!("{}.json", name)
  };
  if n.len() > 200 || n.contains("..") || n.contains('/') || n.contains('\\') {
    return Err(format!("非法文件名：{}", name));
  }
  if !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.') {
    return Err(format!("非法文件名：{}", name));
  }
  Ok(n)
}

fn backups_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("backups");
  fs::create_dir_all(&d).map_err(|e| e.to_string())?;
  Ok(d)
}

fn recent_file(app: &AppHandle) -> Result<PathBuf, String> {
  let d = app.path().app_config_dir().map_err(|e| e.to_string())?;
  fs::create_dir_all(&d).map_err(|e| e.to_string())?;
  Ok(d.join("recent.json"))
}

fn read_recent(app: &AppHandle) -> Vec<RecentDir> {
  let Ok(f) = recent_file(app) else { return vec![] };
  let Ok(txt) = fs::read_to_string(&f) else { return vec![] };
  serde_json::from_str::<Vec<RecentDir>>(&txt).unwrap_or_default()
}

fn write_recent(app: &AppHandle, list: &[RecentDir]) -> Result<(), String> {
  let f = recent_file(app)?;
  let txt = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
  fs::write(&f, txt).map_err(|e| e.to_string())
}

fn current_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
  let guard = state.root.lock().map_err(|_| "内部状态锁失败".to_string())?;
  guard.clone().ok_or_else(|| "还没有选择配置目录".to_string())
}

fn push_recent(app: &AppHandle, root: &Path, tables: usize) {
  let mut list = read_recent(app);
  let key = root.to_string_lossy().replace('\\', "/");
  list.retain(|r| r.path.replace('\\', "/") != key);
  list.insert(
    0,
    RecentDir {
      path: root.to_string_lossy().to_string(),
      name: root.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| key.clone()),
      tables,
      last: now_ms(),
    },
  );
  list.truncate(MAX_RECENT);
  let _ = write_recent(app, &list);
}

/* ---------------- 命令 ---------------- */

#[tauri::command]
fn ping(state: State<'_, AppState>) -> Result<PingInfo, String> {
  let root = current_root(&state)?;
  let dir = configs_of(&root);
  Ok(PingInfo {
    config_dir: dir.to_string_lossy().to_string(),
    version: env!("CARGO_PKG_VERSION").to_string(),
  })
}

#[tauri::command]
fn list_tables(state: State<'_, AppState>) -> Result<Vec<TableInfo>, String> {
  let root = current_root(&state)?;
  let dir = configs_of(&root);
  let rd = fs::read_dir(&dir).map_err(|e| format!("读取目录失败：{}", e))?;
  let mut out = Vec::new();
  for e in rd.flatten() {
    let name = e.file_name().to_string_lossy().to_string();
    if !name.to_lowercase().ends_with(".json") {
      continue;
    }
    let Ok(meta) = e.metadata() else { continue };
    if !meta.is_file() {
      continue;
    }
    out.push(TableInfo {
      name,
      size: meta.len(),
      mtime: mtime_ms(&meta),
    });
  }
  out.sort_by(|a, b| a.name.cmp(&b.name));
  Ok(out)
}

#[tauri::command]
fn read_file(state: State<'_, AppState>, name: String) -> Result<String, String> {
  let root = current_root(&state)?;
  let file = configs_of(&root).join(safe_name(&name)?);
  let bytes = fs::read(&file).map_err(|e| format!("读取失败：{}（{}）", name, e))?;
  String::from_utf8(bytes).map_err(|_| format!("{} 不是 UTF-8 文件", name))
}

#[tauri::command]
fn save_file(app: AppHandle, state: State<'_, AppState>, name: String, contents: String) -> Result<SaveResult, String> {
  let root = current_root(&state)?;
  let file_name = safe_name(&name)?;
  let path = configs_of(&root).join(&file_name);
  if !path.is_file() {
    return Err(format!("文件不存在：{}", file_name));
  }
  // 1) 先备份原文件
  let backup_id = format!("{}--{}", stamp(), file_name);
  let bdir = backups_dir(&app)?;
  fs::copy(&path, bdir.join(&backup_id)).map_err(|e| format!("备份失败：{}", e))?;
  // 2) 临时文件 + rename 覆盖（同目录，原子替换）
  let tmp = path.with_extension("json.tmp");
  fs::write(&tmp, contents.as_bytes()).map_err(|e| format!("写入失败：{}", e))?;
  if let Err(e) = fs::rename(&tmp, &path) {
    let _ = fs::remove_file(&tmp);
    return Err(format!("写入失败：{}", e));
  }
  Ok(SaveResult { backup: backup_id })
}

#[tauri::command]
fn list_backups(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
  let dir = backups_dir(&app)?;
  let rd = fs::read_dir(&dir).map_err(|e| e.to_string())?;
  let mut out = Vec::new();
  for e in rd.flatten() {
    let id = e.file_name().to_string_lossy().to_string();
    if !id.to_lowercase().ends_with(".json") {
      continue;
    }
    let Ok(meta) = e.metadata() else { continue };
    if !meta.is_file() {
      continue;
    }
    out.push(BackupInfo {
      created_at: id_created_at(&id),
      id,
      size: meta.len(),
      mtime: mtime_ms(&meta),
    });
  }
  /* 按 id 倒序：id 前缀是 ISO 时间戳（去掉了 : 和 .），字典序就是时间序。
     不能用 mtime —— fs::copy 保留源文件 mtime，列表第一条可能不是最近一次备份。 */
  out.sort_by(|a, b| b.id.cmp(&a.id));
  Ok(out)
}

#[tauri::command]
fn undo(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<UndoResult, String> {
  let root = current_root(&state)?;
  let table = id
    .rsplit_once("--")
    .map(|(_, t)| t.to_string())
    .ok_or_else(|| format!("备份名看不懂：{}", id))?;
  let table_name = safe_name(&table)?;
  let bdir = backups_dir(&app)?;
  let src = bdir.join(&id);
  if !src.is_file() {
    return Err(format!("备份不存在：{}", id));
  }
  let path = configs_of(&root).join(&table_name);
  if !path.is_file() {
    return Err(format!("目标文件不存在：{}", table_name));
  }
  // 撤销前也先备份当前版本，保证可再撤回来
  let backup_id = format!("{}--{}", stamp(), table_name);
  fs::copy(&path, bdir.join(&backup_id)).map_err(|e| format!("备份当前版本失败：{}", e))?;
  fs::copy(&src, &path).map_err(|e| format!("还原失败：{}", e))?;
  /* 返回给前端的表名不带 .json（与 preview / apply 的 table 参数保持一致），
     否则 reloadAfterSave 会拿 "Config_X.json" 去查缓存，刷不到侧栏行数。 */
  let bare = table_name.trim_end_matches(".json").to_string();
  Ok(UndoResult { backup: backup_id, table: bare })
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> Result<Option<ConfigInfo>, String> {
  let root = {
    let guard = state.root.lock().map_err(|_| "内部状态锁失败".to_string())?;
    guard.clone()
  };
  let Some(root) = root else { return Ok(None) };
  match validate_dir(&root) {
    Ok((_, n)) => Ok(Some(ConfigInfo {
      path: root.to_string_lossy().to_string(),
      name: root.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
      tables: n,
    })),
    Err(_) => Ok(None),
  }
}

#[tauri::command]
fn set_config(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<ConfigInfo, String> {
  let p = PathBuf::from(&path);
  let (root, tables) = validate_dir(&p)?;
  {
    let mut guard = state.root.lock().map_err(|_| "内部状态锁失败".to_string())?;
    *guard = Some(root.clone());
  }
  push_recent(&app, &root, tables);
  Ok(ConfigInfo {
    path: root.to_string_lossy().to_string(),
    name: root.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
    tables,
  })
}

#[tauri::command]
fn clear_config(state: State<'_, AppState>) -> Result<(), String> {
  let mut guard = state.root.lock().map_err(|_| "内部状态锁失败".to_string())?;
  *guard = None;
  Ok(())
}

#[tauri::command]
fn list_recent(app: AppHandle) -> Vec<RecentOut> {
  read_recent(&app)
    .into_iter()
    .map(|r| {
      let exists = Path::new(&r.path).is_dir();
      RecentOut { path: r.path, name: r.name, tables: r.tables, last: r.last, exists }
    })
    .collect()
}

#[tauri::command]
fn remove_recent(app: AppHandle, path: String) -> Result<(), String> {
  let key = path.replace('\\', "/");
  let mut list = read_recent(&app);
  list.retain(|r| r.path.replace('\\', "/") != key);
  write_recent(&app, &list)
}

/* ---------------- Git ---------------- */
/* 全部转给 git 命令行执行：用户机器上本来就有 Git（配置仓库本身是 git 仓库），
   比自己链 libgit2 省事，也不会因为 .git 的新格式读不了。 */

fn git_dir(state: &State<'_, AppState>) -> Result<PathBuf, String> {
  let root = current_root(state)?;
  Ok(configs_of(&root))
}

/* 这些命令都会起子进程，git pull / push 还可能等网络。同步命令跑在 Tauri 的主线程上，
   一旦慢就是整个窗口无响应（连刷新的 git 状态都画不出来），所以统一 async + spawn_blocking。 */

#[tauri::command]
async fn git_info(state: State<'_, AppState>) -> Result<git::GitInfo, String> {
  let dir = git_dir(&state)?;
  Ok(tauri::async_runtime::spawn_blocking(move || git::info(&dir))
    .await
    .map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn git_status(state: State<'_, AppState>) -> Result<Vec<git::GitFile>, String> {
  let dir = git_dir(&state)?;
  Ok(tauri::async_runtime::spawn_blocking(move || git::status(&dir))
    .await
    .map_err(|e| e.to_string())??)
}

#[tauri::command]
async fn git_branches(state: State<'_, AppState>) -> Result<Vec<git::GitBranch>, String> {
  let dir = git_dir(&state)?;
  Ok(tauri::async_runtime::spawn_blocking(move || git::branches(&dir))
    .await
    .map_err(|e| e.to_string())??)
}

#[tauri::command]
async fn git_checkout(state: State<'_, AppState>, branch: String) -> Result<String, String> {
  let dir = git_dir(&state)?;
  Ok(tauri::async_runtime::spawn_blocking(move || git::checkout(&dir, &branch))
    .await
    .map_err(|e| e.to_string())??)
}

#[tauri::command]
async fn git_diff(state: State<'_, AppState>, path: String) -> Result<String, String> {
  let dir = git_dir(&state)?;
  Ok(tauri::async_runtime::spawn_blocking(move || git::diff(&dir, &path))
    .await
    .map_err(|e| e.to_string())??)
}

#[tauri::command]
async fn git_log(state: State<'_, AppState>, limit: Option<usize>) -> Result<Vec<git::GitCommit>, String> {
  let dir = git_dir(&state)?;
  let n = limit.unwrap_or(50);
  Ok(tauri::async_runtime::spawn_blocking(move || git::log(&dir, n))
    .await
    .map_err(|e| e.to_string())??)
}

#[tauri::command]
async fn git_pull(state: State<'_, AppState>) -> Result<String, String> {
  let dir = git_dir(&state)?;
  Ok(tauri::async_runtime::spawn_blocking(move || git::pull(&dir))
    .await
    .map_err(|e| e.to_string())??)
}

#[tauri::command]
async fn git_push(state: State<'_, AppState>) -> Result<String, String> {
  let dir = git_dir(&state)?;
  Ok(tauri::async_runtime::spawn_blocking(move || git::push(&dir))
    .await
    .map_err(|e| e.to_string())??)
}

#[tauri::command]
async fn git_commit(
  state: State<'_, AppState>,
  message: String,
  paths: Option<Vec<String>>,
) -> Result<String, String> {
  let dir = git_dir(&state)?;
  let ps = paths.unwrap_or_default();
  Ok(tauri::async_runtime::spawn_blocking(move || git::commit(&dir, &message, &ps))
    .await
    .map_err(|e| e.to_string())??)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(AppState::default())
    .invoke_handler(tauri::generate_handler![
      ping,
      list_tables,
      read_file,
      save_file,
      list_backups,
      undo,
      get_config,
      set_config,
      clear_config,
      list_recent,
      remove_recent,
      git_info,
      git_status,
      git_branches,
      git_checkout,
      git_diff,
      git_log,
      git_pull,
      git_push,
      git_commit
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
