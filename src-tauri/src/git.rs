/* Git 集成：直接在配置仓库里跑 git 命令。
 *
 * 只做「日常够用」的几件事：看分支 / 切分支 / 看变更 / 看 diff / 拉取 / 推送 / 看历史。
 * 刻意不做 merge / rebase / reset --hard / push --force —— 冲突要让用户回命令行处理，
 * 工具里静默改写历史的风险太大。
 */
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
  is_repo: bool,
  root: String,
  branch: String,
  detached: bool,
  upstream: String,
  remote: String,
  ahead: u32,
  behind: u32,
  dirty: usize,
  error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
  path: String,
  code: String,
  staged: bool,
  untracked: bool,
  label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
  name: String,
  current: bool,
  remote: bool,
  upstream: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
  hash: String,
  short: String,
  author: String,
  time: String,
  subject: String,
}

/// 统一跑 git：关掉交互式凭据提示（否则 pull/push 会卡在认证等待），输出按 UTF-8 宽松解码。
///
/// Windows 上必须加 CREATE_NO_WINDOW：Tauri 是 GUI 进程，没有控制台，
/// 不加这个标志每个 git 调用都会闪一个黑色命令行窗口（用户看到的就是「频繁弹框」）。
fn run(dir: &Path, args: &[&str]) -> Result<String, String> {
  let mut cmd = Command::new("git");
  cmd
    .args(args)
    .current_dir(dir)
    .env("GIT_TERMINAL_PROMPT", "0")
    .env("GIT_OPTIONAL_LOCKS", "0")
    .env("LC_ALL", "C");
  #[cfg(windows)]
  cmd.creation_flags(CREATE_NO_WINDOW);
  let out = cmd
    .output()
    .map_err(|e| format!("无法运行 git：{}（请确认已安装 Git 并加入 PATH）", e))?;
  if !out.status.success() {
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let msg = if err.is_empty() { format!("git {} 失败", args.join(" ")) } else { err };
    return Err(msg);
  }
  Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// 只取 stdout、不看退出码。
/// `git diff --no-index` 在「有差异」时返回 1——但那正是我们要的输出。
fn run_raw(dir: &Path, args: &[&str]) -> String {
  let mut cmd = Command::new("git");
  cmd
    .args(args)
    .current_dir(dir)
    .env("GIT_TERMINAL_PROMPT", "0")
    .env("GIT_OPTIONAL_LOCKS", "0")
    .env("LC_ALL", "C");
  #[cfg(windows)]
  cmd.creation_flags(CREATE_NO_WINDOW);
  match cmd.output() {
    Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
    Err(_) => String::new(),
  }
}

fn repo_root(dir: &Path) -> Result<PathBuf, String> {
  let out = run(dir, &["rev-parse", "--show-toplevel"])?;
  let t = out.trim();
  if t.is_empty() {
    return Err("不是 git 仓库".to_string());
  }
  Ok(PathBuf::from(t))
}

pub fn info(dir: &Path) -> GitInfo {
  let mut info = GitInfo {
    is_repo: false,
    root: String::new(),
    branch: String::new(),
    detached: false,
    upstream: String::new(),
    remote: String::new(),
    ahead: 0,
    behind: 0,
    dirty: 0,
    error: String::new(),
  };

  let root = match repo_root(dir) {
    Ok(r) => r,
    Err(e) => {
      info.error = e;
      return info;
    }
  };
  info.is_repo = true;
  info.root = root.to_string_lossy().to_string();

  /* 一条 `status --porcelain=v2 --branch` 就够：头部三行给出分支、上游、领先/落后，
     其余行是改动文件，数量即 dirty。原来分开跑 rev-parse / rev-list / remote / status
     要 5 个 git 进程，Windows 上每个进程都要 100~300ms，打开面板会明显卡顿。 */
  if let Ok(out) = run(&root, &["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]) {
    for line in out.lines() {
      if let Some(v) = line.strip_prefix("# branch.head ") {
        let b = v.trim();
        if b == "(detached)" {
          info.detached = true;
        } else {
          info.branch = b.to_string();
        }
      } else if let Some(v) = line.strip_prefix("# branch.upstream ") {
        info.upstream = v.trim().to_string();
      } else if let Some(v) = line.strip_prefix("# branch.ab ") {
        // 形如 "+1 -2"
        for tok in v.split_whitespace() {
          if let Some(n) = tok.strip_prefix('+') {
            info.ahead = n.parse().unwrap_or(0);
          } else if let Some(n) = tok.strip_prefix('-') {
            info.behind = n.parse().unwrap_or(0);
          }
        }
      } else if !line.starts_with('#') && !line.trim().is_empty() {
        info.dirty += 1;
      }
    }
  }

  // 远端地址单独一条（只用于面板顶部显示）；拿不到不算错误
  if let Some(remote_name) = info.upstream.split('/').next() {
    if !remote_name.is_empty() {
      if let Ok(u) = run(&root, &["remote", "get-url", remote_name]) {
        info.remote = u.trim().to_string();
      }
    }
  }
  info
}

pub fn status(dir: &Path) -> Result<Vec<GitFile>, String> {
  let root = repo_root(dir)?;
  // normal 而不是 all：all 要把每个未跟踪目录里的文件逐个列出来，大仓库会明显变慢
  let out = run(&root, &["status", "--porcelain", "--untracked-files=normal"])?;
  let mut list = Vec::new();
  for line in out.lines() {
    if line.len() < 3 {
      continue;
    }
    let x = line.as_bytes()[0] as char;
    let y = line.as_bytes()[1] as char;
    let path = line[3..].trim().to_string();
    if path.is_empty() {
      continue;
    }
    let staged = x != ' ' && x != '?';
    let untracked = x == '?' && y == '?';
    let label = if untracked {
      "未跟踪".to_string()
    } else if x == 'A' || y == 'A' {
      "新增".to_string()
    } else if x == 'D' || y == 'D' {
      "删除".to_string()
    } else if x == 'R' {
      "重命名".to_string()
    } else if x == 'M' || y == 'M' {
      "修改".to_string()
    } else {
      "变更".to_string()
    };
    list.push(GitFile { path, code: format!("{}{}", x, y), staged, untracked, label });
  }
  Ok(list)
}

pub fn branches(dir: &Path) -> Result<Vec<GitBranch>, String> {
  let root = repo_root(dir)?;
  let out = run(
    &root,
    &["branch", "-a", "--format=%(refname:short)|%(HEAD)|%(upstream:short)"],
  )?;
  let mut local = Vec::new();
  let mut remote = Vec::new();
  for line in out.lines() {
    let mut it = line.splitn(3, '|');
    let name = it.next().unwrap_or("").trim().to_string();
    let head = it.next().unwrap_or("").trim().to_string();
    let up = it.next().unwrap_or("").trim().to_string();
    if name.is_empty() || name.ends_with("/HEAD") {
      continue;
    }
    let is_remote = name.starts_with("origin/") || name.starts_with("upstream/");
    let item = GitBranch { name, current: head == "*", remote: is_remote, upstream: up };
    if is_remote { remote.push(item) } else { local.push(item) }
  }
  local.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
  remote.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
  local.extend(remote);
  Ok(local)
}

pub fn checkout(dir: &Path, branch: &str) -> Result<String, String> {
  let root = repo_root(dir)?;
  let b = branch.trim();
  if b.is_empty() || b.starts_with('-') {
    return Err(format!("非法分支名：{}", branch));
  }
  if let Some((_, rest)) = b.split_once('/') {
    // 远程分支：建本地跟踪分支。origin/foo -> foo
    if b.starts_with("origin/") || b.starts_with("upstream/") {
      let short = rest.to_string();
      run(&root, &["checkout", "-b", &short, "--track", b])?;
      return Ok(short);
    }
  }
  run(&root, &["checkout", b])?;
  Ok(b.to_string())
}

pub fn diff(dir: &Path, path: &str) -> Result<String, String> {
  let root = repo_root(dir)?;
  let p = path.trim();
  if p.is_empty() {
    return Ok(String::new());
  }
  // 未暂存 + 已暂存都拼上，用户点一个文件就能看到全部改动
  let a = run(&root, &["diff", "--no-color", "--", p]).unwrap_or_default();
  let b = run(&root, &["diff", "--cached", "--no-color", "--", p]).unwrap_or_default();
  let untracked = run(&root, &["ls-files", "--others", "--exclude-standard", "--", p]).unwrap_or_default();
  let mut out = String::new();
  if !b.trim().is_empty() {
    out.push_str("── 已暂存 ──")
    ;
    out.push('\n');
    out.push_str(&b);
  }
  if !a.trim().is_empty() {
    if !out.is_empty() { out.push('\n'); }
    out.push_str("── 未暂存 ──");
    out.push('\n');
    out.push_str(&a);
  }
  if !untracked.trim().is_empty() {
    // 未跟踪文件在 git diff 里永远是空的，所以拿它跟 /dev/null 比一次，
    // 才能显示这个新文件到底写了什么（git for Windows 也认 /dev/null）。
    let u = run_raw(&root, &["diff", "--no-color", "--no-index", "--", "/dev/null", p]);
    if !out.is_empty() { out.push('\n'); }
    out.push_str("── 新增文件 ──");
    out.push('\n');
    if u.trim().is_empty() {
      out.push_str("（空文件）");
    } else {
      out.push_str(&u);
    }
  }
  if out.chars().count() > 400_000 {
    out = out.chars().take(400_000).collect::<String>();
    out.push_str("\n… diff 太长，已截断");
  }
  Ok(out)
}

pub fn log(dir: &Path, limit: usize) -> Result<Vec<GitCommit>, String> {
  let root = repo_root(dir)?;
  let n = limit.clamp(1, 200).to_string();
  let out = run(
    &root,
    &["log", "-n", &n, "--date=format:%Y-%m-%d %H:%M", "--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s"],
  )?;
  let mut list = Vec::new();
  for line in out.lines() {
    let f: Vec<&str> = line.splitn(5, '\t').collect();
    if f.len() < 5 {
      continue;
    }
    list.push(GitCommit {
      hash: f[0].to_string(),
      short: f[1].to_string(),
      author: f[2].to_string(),
      time: f[3].to_string(),
      subject: f[4].to_string(),
    });
  }
  Ok(list)
}

pub fn pull(dir: &Path) -> Result<String, String> {
  let root = repo_root(dir)?;
  let out = run(&root, &["pull", "--ff-only"])?;
  Ok(out.trim().to_string())
}

pub fn push(dir: &Path) -> Result<String, String> {
  let root = repo_root(dir)?;
  let out = run(&root, &["push"])?;
  Ok(out.trim().to_string())
}
