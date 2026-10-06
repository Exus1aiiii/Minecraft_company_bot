#Requires -Version 5.1
<#
  install-node.ps1 —— 把 Node 22 LTS 装进 runtime\（"从源码跑起来"的第一步）。

  ★ 为什么这一步是 PowerShell，而不是 tools\bootstrap.mjs 里的一段代码：
    「先有鸡还是先有蛋」—— bootstrap.mjs 自己要**用 Node 跑**，而普通玩家的 Windows
    上很可能一个 Node 都没有。所有 Windows 都保证有 PowerShell 5.1，所以"把 Node
    弄下来"这件事只能放在这一层。bootstrap.mjs 需要 Node 时就来调这个脚本。

  它做四件事，任何一件失败都退出码 1，并且说清失败的是哪一件：
    ① 下 node-v22.23.3-win-x64.zip（官方源；失败自动换 npmmirror 镜像；HTTP 客户端先
       WebClient 再 curl.exe）。**如果 runtime\ 下已经有一个同名的 zip，就直接用它、不下载**
       —— 公司网 / 代理拦掉 nodejs.org 的人，可以照脚本失败时给的直链自己下好放进去。
    ② 拿官方 SHASUMS256.txt 比对 SHA256（校验文件也下不到时，如实说"跳过校验"，
       不假装校验过）
    ③ 解压到 runtime\node-v22.23.3-win-x64\（优先用系统自带的 tar.exe；没有就退回
       Expand-Archive）。zip 里自带一层同名目录，所以直接解到 runtime\ 就是目标位置。
    ④ 真跑一次 node.exe -v，确认它**不只是文件在，而是能起来**。

  用法（一般人不用手敲，双击 启动.cmd 会自动走到这里）：
      powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-node.ps1
      powershell ... -File tools\install-node.ps1 -Version 22.23.3
      powershell ... -File tools\install-node.ps1 -Check     # 只看装没装，不下载

  退出码：0 = 装好了（或本来就在）；1 = 没装上。
#>
[CmdletBinding()]
param(
  [string]$Version = '22.23.3',
  [switch]$Check          # 只体检：在就 exit 0，不在就 exit 1（一个字节都不下）
)

$ErrorActionPreference = 'Stop'

# TLS 1.2：PowerShell 5.1 底下的 .NET 默认可能还停在 TLS 1.0，那样连 nodejs.org 会直接失败
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$root    = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$dirName = "node-v$Version-win-x64"
$nodeDir = Join-Path $runtime $dirName
$nodeExe = Join-Path $nodeDir 'node.exe'
$zip     = Join-Path $runtime "$dirName.zip"
$part    = "$zip.part"

$mirrors = @(
  "https://nodejs.org/dist/v$Version",           # 官方
  "https://npmmirror.com/mirrors/node/v$Version" # 国内镜像（官方连不上时的退路）
)

function Say($text, $color) {
  if ($color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
}

function Has-NodeRuntime {
  if (-not (Test-Path $nodeExe)) { return $false }
  # ★ 不只看"文件在不在"：半截解压也会留下一个 node.exe。所以真跑一次。
  $out = ''
  try { $out = (& $nodeExe -v 2>&1 | Out-String).Trim() } catch { return $false }
  if ($LASTEXITCODE -ne 0) { return $false }
  Say ("  Node 运行时已经就位：" + $nodeExe + "（" + $out + "）") 'Green'
  return $true
}

if (Test-Path $nodeExe) {
  if (Has-NodeRuntime) { exit 0 }
  Say '  发现一个跑不起来的 node.exe（多半是上次解压没解完），重新装一次。' 'Yellow'
}

if ($Check) {
  Say ("  Node 运行时：缺失（期望 " + $nodeExe + "）") 'Yellow'
  exit 1
}

if (-not (Test-Path $runtime)) { [void](New-Item -ItemType Directory -Force -Path $runtime) }

# ── ① 下载（已经有 zip 就直接用 —— 这是给"公司网拦了 nodejs.org"的人留的路）────────
$ProgressPreference = 'SilentlyContinue'   # PS 5.1 的进度条会把下载拖慢好几倍
$client = New-Object System.Net.WebClient
$client.Headers.Add('User-Agent', 'mc-company-bot-install-node')
$curlExe = Join-Path $env:SystemRoot 'System32\curl.exe'   # Win10 1803+ 自带，代理环境下有时比 .NET 好使
$methods = @('WebClient')
if (Test-Path $curlExe) { $methods += 'curl' }

$downloaded = $false
$preExisting = Test-Path $zip          # 用户自己放好的 zip，别在成功后替他删掉
if ($preExisting) {
  # ★ 这条分支必须存在：脚本失败时我们**叫用户自己下好放这儿**，下一句就得认它，
  #   否则"再跑一次它会直接用这个 zip"就成了骗人的话（冷启动验证时抓到的）。
  $mb0 = [math]::Round((Get-Item $zip).Length / 1MB, 1)
  Say ("  发现已经下好的 zip，跳过下载：" + $zip + "（" + $mb0 + " MB）") 'Green'
  $downloaded = $true
}

if (-not $downloaded) {
  foreach ($base in $mirrors) {
    foreach ($how in $methods) {
      $url = "$base/$dirName.zip"
      Say ("  正在下载 Node " + $Version + "（" + $how + "）：" + $url) 'Cyan'
      try {
        if (Test-Path $part) { Remove-Item -LiteralPath $part -Force }
        if ($how -eq 'WebClient') {
          $client.DownloadFile($url, $part)
        } else {
          & $curlExe -sS -L --fail --max-time 900 -o $part $url
          if ($LASTEXITCODE -ne 0 -or -not (Test-Path $part)) { throw "curl 退出码 $LASTEXITCODE" }
        }
        if ((Get-Item $part).Length -lt 1MB) { throw '下回来的文件太小，不像 Node 的安装包' }
        Move-Item -LiteralPath $part -Destination $zip -Force
        $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
        Say ("  下载完成：" + $mb + " MB") 'Green'
        $downloaded = $true
        break
      } catch {
        Say ("  这条不行：" + $_.Exception.Message) 'Yellow'
      }
    }
    if ($downloaded) { break }
  }
}
if (-not $downloaded) {
  Say ''; Say '✗ Node 下载失败：官方源和国内镜像、WebClient 和 curl 都没连上。' 'Red'
  Say '  请检查网络（公司网/代理常常拦 nodejs.org），或**用浏览器自己下好**这个文件：' 'Red'
  Say ("      https://nodejs.org/dist/v" + $Version + "/" + $dirName + ".zip") 'Red'
  Say '  放到这个位置（不用解压）：' 'Red'
  Say ("      " + $zip) 'Red'
  Say ("  再跑一次本脚本，它会直接用这个 zip。") 'Red'
  exit 1
}

# ── ② 校验 SHA256 ─────────────────────────────────────────────────────────────
$verified = $false
foreach ($base in $mirrors) {
  try {
    $sums = $client.DownloadString("$base/SHASUMS256.txt")
    $line = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape("$dirName.zip") } | Select-Object -First 1)
    if (-not $line) { continue }
    $want = ($line -split '\s+')[0].Trim().ToLower()
    $got  = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
    if ($want -eq $got) {
      Say ("  SHA256 校验通过：" + $got.Substring(0, 16) + "…") 'Green'
      $verified = $true
    } else {
      Say ''; Say '✗ SHA256 对不上 —— 下载的文件不是官方那份（中途坏掉或被改了）。' 'Red'
      Say ("  期望 " + $want) 'Red'
      Say ("  实得 " + $got) 'Red'
      Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
      exit 1
    }
    break
  } catch { }
}
if (-not $verified) {
  # 不硬失败：校验文件下不到时（某些代理会拦 .txt），如实说明并继续 —— 但绝不假装校验过
  Say '  ⚠ 没拿到官方 SHASUMS256.txt，跳过哈希校验（下载源本身仍是 https）。' 'Yellow'
}

# ── ③ 解压 ────────────────────────────────────────────────────────────────────
$tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'   # Windows 10+ 自带（bsdtar，能读 zip）
$extracted = $false
if (Test-Path $tarExe) {
  Say '  正在解压（tar）…'
  & $tarExe -xf $zip -C $runtime
  if ($LASTEXITCODE -eq 0 -and (Test-Path $nodeExe)) { $extracted = $true }
}
if (-not $extracted) {
  Say '  正在解压（Expand-Archive，慢一些）…'
  try {
    Expand-Archive -LiteralPath $zip -DestinationPath $runtime -Force
  } catch {
    Say ''; Say '✗ 解压失败：' 'Red'; Say ('  ' + $_.Exception.Message) 'Red'
    Say '  常见原因：磁盘空间不够，或杀毒软件锁住了文件。' 'Red'
    exit 1
  }
}

# ── ④ 真跑一次 ────────────────────────────────────────────────────────────────
if (-not (Test-Path $nodeExe)) {
  Say ''; Say ('✗ 解压完了却找不到 ' + $nodeExe) 'Red'
  Say '  请把 runtime\ 下这一份删掉再跑一次本脚本。' 'Red'
  exit 1
}
$ver = ''
try { $ver = (& $nodeExe -v 2>&1 | Out-String).Trim() } catch { }
if ($LASTEXITCODE -ne 0 -or -not $ver) {
  Say ''; Say '✗ node.exe 起来了但没能打印版本号 —— 这份运行时不可用。' 'Red'
  Say '  常见原因：杀毒软件把它隔离了（腾讯电脑管家/360 对刚下载的 exe 很敏感）。' 'Red'
  exit 1
}

if (-not $preExisting) { Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue }
Say ''
Say ('✓ Node ' + $ver + ' 装好了：' + $nodeDir) 'Green'
Say '  引擎依赖要求 Node >= 22（Node 24 会踩原生依赖），所以这里固定 22 LTS。'
if ($preExisting) { Say '  （你自己放的那个 zip 我留着没删，下次重装还能用。）' }
exit 0
