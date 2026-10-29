<#
  配置工作台 · 本地服务（Windows PowerShell 5.1，零依赖）
  职责只有三件：供静态文件、读配置原文、写配置原文（带备份）。
  JSON 解析 / 编辑 / 校验 / diff 全部在浏览器里完成。
#>
param(
  [int]$Port = 5179,
  [string]$ConfigDir = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$CRLF = [string][char]13 + [char]10

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DistDir = Split-Path -Parent $ScriptDir
$BackupDir = Join-Path $DistDir 'backups'

function Write-Log([string]$msg) {
  $t = (Get-Date).ToString('HH:mm:ss')
  Write-Host "[$t] $msg" -ForegroundColor DarkGray
}

function Fail([string]$msg) {
  Write-Host ''
  Write-Host ' 启动失败：' -ForegroundColor Red
  Write-Host "  $msg" -ForegroundColor Red
  Write-Host ''
  exit 1
}

function Test-HasConfigs([string]$dir) {
  $c = Join-Path $dir 'configs'
  if (-not (Test-Path -LiteralPath $c)) { return $false }
  $any = Get-ChildItem -LiteralPath $c -Filter 'Config_*.json' -ErrorAction SilentlyContinue | Select-Object -First 1
  return [bool]$any
}

# 参数或 config-dir.txt 里给「配置仓库根」或「它的 configs 目录」都接受，统一成 configs 目录
function Normalize-ConfigDir([string]$dir) {
  $full = (Get-Item -LiteralPath $dir).FullName
  if ((Split-Path -Leaf $full) -ieq 'configs') { return $full }
  if (Test-HasConfigs $full) { return (Join-Path $full 'configs') }
  return $full
}

# 读 config-dir.txt：第一行是配置仓库路径。相对路径按 dist 目录算。
function Read-ConfigDirFile([string]$file) {
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try {
    $raw = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)
  } catch {
    return $null
  }
  $line = ($raw -split "\r?\n")[0]
  if (-not $line) { return $null }
  $line = $line.Trim().TrimStart([char]0xFEFF).Trim()
  if (-not $line) { return $null }
  if (-not [System.IO.Path]::IsPathRooted($line)) { $line = Join-Path $DistDir $line }
  if (-not (Test-Path -LiteralPath $line)) { return $null }
  $full = Normalize-ConfigDir $line
  if (Test-Path -LiteralPath (Join-Path $full 'Config_TimeControl.json')) { return $full }
  if (Test-Path -LiteralPath $full) { return $full }
  return $null
}

function Find-ConfigDir([string]$start) {
  $d = Get-Item -LiteralPath $start
  for ($i = 0; $i -lt 6 -and $d; $i++) {
    if (Test-HasConfigs $d.FullName) { return (Join-Path $d.FullName 'configs') }
    $d = $d.Parent
  }
  return $null
}

if ($ConfigDir) {
  if (-not (Test-Path -LiteralPath $ConfigDir)) { Fail "指定的配置目录不存在：$ConfigDir" }
  $ConfigDir = Normalize-ConfigDir $ConfigDir
  if (-not (Test-Path -LiteralPath (Join-Path $ConfigDir 'Config_TimeControl.json'))) {
    Fail "指定的目录里没有配置 JSON：$ConfigDir"
  }
} else {
  foreach ($f in @((Join-Path $DistDir 'config-dir.txt'), (Join-Path (Split-Path -Parent $DistDir) 'config-dir.txt'))) {
    $ConfigDir = Read-ConfigDirFile $f
    if ($ConfigDir) { break }
  }
}
if (-not $ConfigDir) { $ConfigDir = Find-ConfigDir $DistDir }
if (-not $ConfigDir) {
  Fail ('找不到配置目录 configs。三选一：' + $CRLF +
        '  1. 把本工具（dist 目录）放进配置仓库，让上级目录里有 configs/Config_*.json；' + $CRLF +
        '  2. 在 dist 目录或它的上一级建 config-dir.txt，写一行配置仓库路径（示例见 config-dir.example.txt）；' + $CRLF +
        '  3. 启动时指定：启动.bat -ConfigDir "D:/path/to/config_repo"')
}

$listener = $null
for ($try = 0; $try -lt 20; $try++) {
  $p = $Port + $try
  try {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p)
    $l.Start()
    $listener = $l
    $Port = $p
    break
  } catch { }
}
if (-not $listener) { Fail "端口 $Port 起不来（可能都被占用）" }

$url = 'http://127.0.0.1:' + $Port + '/'

Write-Host ''
Write-Host '  配置工作台' -ForegroundColor Cyan
Write-Host "  配置目录： $ConfigDir"
Write-Host "  地址：     $url"
Write-Host '  关闭这个窗口即停止服务。' -ForegroundColor DarkGray
Write-Host ''

$Mime = @{
  '.html'  = 'text/html; charset=utf-8'
  '.js'    = 'text/javascript; charset=utf-8'
  '.css'   = 'text/css; charset=utf-8'
  '.json'  = 'application/json; charset=utf-8'
  '.svg'   = 'image/svg+xml'
  '.png'   = 'image/png'
  '.ico'   = 'image/x-icon'
  '.woff2' = 'font/woff2'
}

function Send-Bytes($stream, [int]$code, [string]$ctype, [byte[]]$body) {
  $reason = @{ 200 = 'OK'; 400 = 'Bad Request'; 404 = 'Not Found'; 405 = 'Method Not Allowed'; 500 = 'Internal Server Error' }[$code]
  if (-not $reason) { $reason = 'OK' }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('HTTP/1.1 ' + $code + ' ' + $reason + $CRLF)
  [void]$sb.Append('Content-Type: ' + $ctype + $CRLF)
  [void]$sb.Append('Content-Length: ' + $body.Length + $CRLF)
  [void]$sb.Append('Cache-Control: no-store' + $CRLF)
  [void]$sb.Append('Connection: close' + $CRLF)
  [void]$sb.Append($CRLF)
  $head = [System.Text.Encoding]::ASCII.GetBytes($sb.ToString())
  $stream.Write($head, 0, $head.Length)
  if ($body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
  $stream.Flush()
}

function Send-Json($stream, [int]$code, $obj) {
  $text = $obj | ConvertTo-Json -Depth 8 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  Send-Bytes $stream $code 'application/json; charset=utf-8' $bytes
}

function Send-Text($stream, [int]$code, [string]$text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  Send-Bytes $stream $code 'text/plain; charset=utf-8' $bytes
}

function Read-Request($stream) {
  $ms = New-Object System.IO.MemoryStream
  $buf = New-Object byte[] 16384
  $headEnd = -1
  while ($true) {
    $n = $stream.Read($buf, 0, $buf.Length)
    if ($n -le 0) { break }
    $ms.Write($buf, 0, $n)
    $arr = $ms.GetBuffer()
    $len = [int]$ms.Length
    for ($i = 3; $i -lt $len; $i++) {
      if ($arr[$i] -eq 10 -and $arr[$i-1] -eq 13 -and $arr[$i-2] -eq 10 -and $arr[$i-3] -eq 13) { $headEnd = $i; break }
    }
    if ($headEnd -ge 0) { break }
    if ($len -gt 2097152) { break }
  }
  if ($headEnd -lt 0) { return $null }
  $headText = [System.Text.Encoding]::ASCII.GetString($ms.GetBuffer(), 0, $headEnd + 1)
  $lines = $headText -split $CRLF
  $parts = $lines[0] -split ' '
  $method = $parts[0]
  $target = $parts[1]
  $headers = @{}
  for ($i = 1; $i -lt $lines.Length; $i++) {
    $ln = $lines[$i]
    if (-not $ln) { continue }
    $idx = $ln.IndexOf(':')
    if ($idx -gt 0) { $headers[$ln.Substring(0, $idx).Trim().ToLower()] = $ln.Substring($idx + 1).Trim() }
  }
  $contentLength = 0
  if ($headers.ContainsKey('content-length')) { $contentLength = [int]$headers['content-length'] }
  $bodyBytes = New-Object byte[] 0
  if ($contentLength -gt 0) {
    $already = [int]$ms.Length - ($headEnd + 1)
    $ms2 = New-Object System.IO.MemoryStream
    if ($already -gt 0) { $ms2.Write($ms.GetBuffer(), $headEnd + 1, $already) }
    $need = $contentLength - $already
    while ($need -gt 0) {
      $chunk = New-Object byte[] ([Math]::Min(65536, $need))
      $k = $stream.Read($chunk, 0, $chunk.Length)
      if ($k -le 0) { break }
      $ms2.Write($chunk, 0, $k)
      $need -= $k
    }
    $bodyBytes = $ms2.ToArray()
  }
  return @{ method = $method; target = $target; headers = $headers; body = $bodyBytes }
}

function Test-ConfigName([string]$name) {
  return ($name -match '^Config_[A-Za-z0-9_]+(\.[A-Za-z0-9_-]+)?\.json$')
}

function Handle-Request($req) {
  $method = $req.method
  $raw = $req.target
  $qi = $raw.IndexOf('?')
  if ($qi -ge 0) { $path = $raw.Substring(0, $qi); $q = $raw.Substring($qi + 1) } else { $path = $raw; $q = '' }
  $query = @{}
  foreach ($pair in ($q -split '&')) {
    if (-not $pair) { continue }
    $kv = $pair -split '=', 2
    $key = [System.Uri]::UnescapeDataString($kv[0])
    if ($kv.Length -gt 1) { $query[$key] = [System.Uri]::UnescapeDataString($kv[1]) } else { $query[$key] = '' }
  }

  if ($method -eq 'GET' -and $path -eq '/api/ping') {
    return @{ code = 200; json = @{ ok = $true; configDir = $ConfigDir; version = 1 } }
  }

  if ($method -eq 'GET' -and $path -eq '/api/tables') {
    $list = New-Object System.Collections.ArrayList
    foreach ($f in (Get-ChildItem -LiteralPath $ConfigDir -Filter 'Config_*.json' | Sort-Object Name)) {
      [void]$list.Add(@{ name = $f.Name; size = $f.Length; mtime = ([DateTimeOffset]$f.LastWriteTimeUtc).ToUnixTimeMilliseconds() })
    }
    return @{ code = 200; json = @{ ok = $true; dir = $ConfigDir; tables = $list.ToArray() } }
  }

  if ($method -eq 'GET' -and $path -eq '/api/schemas') {
    # 语义层已改成运行时从 schema 现算，这里把 94 个 schema 拼成一个 JSON 对象一次返回。
    # 一个文件一个请求太慢；也不走 ConvertFrom-Json 再 ConvertTo-Json——4MB 会明显拖慢。
    $schemaDir = Join-Path (Split-Path -Parent $ConfigDir) 'json-schemas'
    if (-not (Test-Path -LiteralPath $schemaDir)) { return @{ code = 404; json = @{ ok = $false; error = '没有 json-schemas 目录' } } }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('{')
    $first = $true
    foreach ($f in (Get-ChildItem -LiteralPath $schemaDir -Filter '*.json' | Sort-Object Name)) {
      $body = [System.IO.File]::ReadAllText($f.FullName).TrimStart([char]0xFEFF).Trim()
      if (-not $body) { continue }
      if (-not $first) { [void]$sb.Append(',') }
      $first = $false
      [void]$sb.Append('"').Append($f.BaseName).Append('":')
      [void]$sb.Append($body)
    }
    [void]$sb.Append('}')
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($sb.ToString())
    return @{ code = 200; raw = $bytes; ctype = 'application/json; charset=utf-8' }
  }

  if ($method -eq 'GET' -and $path -eq '/api/file') {
    $name = $query['name']
    if (-not (Test-ConfigName $name)) { return @{ code = 400; json = @{ ok = $false; error = '非法文件名' } } }
    $file = Join-Path $ConfigDir $name
    if (-not (Test-Path -LiteralPath $file)) { return @{ code = 404; json = @{ ok = $false; error = '文件不存在' } } }
    $bytes = [System.IO.File]::ReadAllBytes($file)
    return @{ code = 200; raw = $bytes; ctype = 'application/json; charset=utf-8' }
  }

  if ($method -eq 'POST' -and $path -eq '/api/save') {
    $name = $query['name']
    if (-not (Test-ConfigName $name)) { return @{ code = 400; json = @{ ok = $false; error = '非法文件名' } } }
    $file = Join-Path $ConfigDir $name
    if (-not (Test-Path -LiteralPath $file)) { return @{ code = 404; json = @{ ok = $false; error = '文件不存在' } } }
    if ($req.body.Length -lt 2) { return @{ code = 400; json = @{ ok = $false; error = '内容为空' } } }
    if (-not (Test-Path -LiteralPath $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir | Out-Null }
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
    $backupId = $stamp + '--' + $name
    Copy-Item -LiteralPath $file -Destination (Join-Path $BackupDir $backupId) -Force
    # BOM 对齐：浏览器 fetch().text() 会 strip UTF-8 BOM，直接写回会把带 BOM 的文件变成无 BOM。
    $orig = [System.IO.File]::ReadAllBytes($file)
    $hadBom = ($orig.Length -ge 3 -and $orig[0] -eq 0xEF -and $orig[1] -eq 0xBB -and $orig[2] -eq 0xBF)
    $body = $req.body
    $hasBom = ($body.Length -ge 3 -and $body[0] -eq 0xEF -and $body[1] -eq 0xBB -and $body[2] -eq 0xBF)
    if ($hadBom -and -not $hasBom) {
      $bom = [byte[]](0xEF, 0xBB, 0xBF)
      $merged = New-Object byte[] ($body.Length + 3)
      [Array]::Copy($bom, 0, $merged, 0, 3)
      [Array]::Copy($body, 0, $merged, 3, $body.Length)
      $body = $merged
    } elseif (-not $hadBom -and $hasBom) {
      $stripped = New-Object byte[] ($body.Length - 3)
      [Array]::Copy($body, 3, $stripped, 0, ($body.Length - 3))
      $body = $stripped
    }
    $tmp = $file + '.tmp-' + $PID
    [System.IO.File]::WriteAllBytes($tmp, $body)
    Move-Item -LiteralPath $tmp -Destination $file -Force
    Write-Log ("保存 " + $name + "（" + $body.Length + " 字节，备份 " + $backupId + "）")
    return @{ code = 200; json = @{ ok = $true; table = $name; backup = $backupId; size = $body.Length } }
  }

  if ($method -eq 'GET' -and $path -eq '/api/backups') {
    $list = New-Object System.Collections.ArrayList
    if (Test-Path -LiteralPath $BackupDir) {
      foreach ($f in (Get-ChildItem -LiteralPath $BackupDir -Filter '*.json' | Sort-Object Name -Descending | Select-Object -First 200)) {
        [void]$list.Add(@{ id = $f.Name; size = $f.Length; mtime = ([DateTimeOffset]$f.LastWriteTimeUtc).ToUnixTimeMilliseconds() })
      }
    }
    return @{ code = 200; json = @{ ok = $true; backups = $list.ToArray() } }
  }

  if ($method -eq 'POST' -and $path -eq '/api/undo') {
    $id = $query['id']
    if (-not $id -or $id -match '[\\/]') { return @{ code = 400; json = @{ ok = $false; error = '非法备份 id' } } }
    $src = Join-Path $BackupDir $id
    if (-not (Test-Path -LiteralPath $src)) { return @{ code = 404; json = @{ ok = $false; error = '备份不存在' } } }
    $name = ($id -split '--', 2)[1]
    if (-not (Test-ConfigName $name)) { return @{ code = 400; json = @{ ok = $false; error = '非法备份 id' } } }
    $file = Join-Path $ConfigDir $name
    $bytes = [System.IO.File]::ReadAllBytes($src)
    [System.IO.File]::WriteAllBytes($file, $bytes)
    Write-Log ('还原 ' + $name + ' <- ' + $id)
    return @{ code = 200; json = @{ ok = $true; table = $name; backup = $id } }
  }

  if ($method -ne 'GET') { return @{ code = 405; json = @{ ok = $false; error = '不支持的方法' } } }

  if ($path -eq '/' -or $path -eq '') { $path = '/index.html' }
  $rel = $path.TrimStart('/')
  if ($rel -match '\.\.') { return @{ code = 400; json = @{ ok = $false; error = '非法路径' } } }
  $distFull = (Get-Item -LiteralPath $DistDir).FullName
  $resolved = [System.IO.Path]::GetFullPath((Join-Path $DistDir $rel))
  if (-not $resolved.StartsWith($distFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    return @{ code = 400; json = @{ ok = $false; error = '非法路径' } }
  }
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { return @{ code = 404; json = @{ ok = $false; error = '文件不存在' } } }
  $ext = [System.IO.Path]::GetExtension($resolved).ToLower()
  $ctype = $Mime[$ext]
  if (-not $ctype) { $ctype = 'application/octet-stream' }
  $bytes = [System.IO.File]::ReadAllBytes($resolved)
  return @{ code = 200; raw = $bytes; ctype = $ctype }
}

if (-not $NoBrowser) { Start-Process $url | Out-Null }
Write-Log ('已打开浏览器：' + $url)

while ($true) {
  $client = $null
  try {
    $client = $listener.AcceptTcpClient()
    $client.ReceiveTimeout = 20000
    $client.SendTimeout = 20000
    $stream = $client.GetStream()
    $req = Read-Request $stream
    if ($null -eq $req) { continue }
    $res = Handle-Request $req
    if ($res.ContainsKey('json')) {
      Send-Json $stream $res.code $res.json
    } elseif ($res.ContainsKey('raw')) {
      Send-Bytes $stream $res.code $res.ctype $res.raw
    } else {
      Send-Text $stream 500 'internal error'
    }
  } catch {
    try { if ($client) { Send-Text $client.GetStream() 500 ('error: ' + $_.Exception.Message) } } catch { }
  } finally {
    if ($client) { try { $client.Close() } catch { } }
  }
}
