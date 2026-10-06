#Requires -Version 5.1
<#
  launch-gui.ps1 —— 「启动.cmd」真正干活的地方。

  ★ 为什么要有这个文件，而不是把逻辑都写在 .cmd 里：
    cmd.exe 用**控制台代码页**（中文 Windows 是 GBK/936）解码 .cmd 文件内容。
    我们原先的 启动.cmd 存成 UTF-8，中文注释被按 GBK 解成乱码，而乱码会**吃掉换行**：
    `rem 这是一句中文注释` 和它下面那行命令被拼成了一条命令。结果就是双击之后
    满屏的「'xxx' 不是内部或外部命令」、窗口根本没出来（实测就是这样，2026-02 用户报障）。
    另一条同样致命：那个文件是 **LF 换行**，而 cmd.exe 期望 CRLF。

    所以规则是两条，tools/check-launchers.mjs 会把它们钉死：
      ① 所有要双击的 .cmd / .bat 必须是**纯 ASCII + CRLF**（一句中文都不能有）；
      ② 中文全部放在本文件里，而本文件必须是 **UTF-8 带 BOM + CRLF**
         （PowerShell 5.1 只有看见 BOM 才会按 UTF-8 读，否则中文照样乱）。

  用法（一般人不需要手敲，双击 启动.cmd 就行）：
      powershell -NoProfile -ExecutionPolicy Bypass -File tools\launch-gui.ps1
      powershell ... -File tools\launch-gui.ps1 -Preview     # 浏览器里预览界面
      powershell ... -File tools\launch-gui.ps1 -Check       # 只检查环境，不启动
#>
[CmdletBinding()]
param(
  [switch]$Preview,   # 起本地预览服务器 + 打开浏览器（不需要 Electron）
  [switch]$Check,     # 只做环境体检并打印结论，不启动任何东西
  [switch]$NoPause    # 出错也不停下来等按键（给自检/脚本调用）
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot 是本文件所在目录（tools），项目根是它上一级
$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }

function Say($text, $color) {
  if ($color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
}

function Pause-IfNeeded {
  if ($NoPause) { return }
  Say ''
  Write-Host '按回车键关闭这个窗口… ' -NoNewline
  try { [void](Read-Host) } catch { Start-Sleep -Seconds 3 }
}

function Fail($lines) {
  Say ''
  foreach ($l in $lines) { Say $l 'Red' }
  Pause-IfNeeded
  exit 1
}

Set-Location -LiteralPath $root

# ---------------------------------------------------------------------------
# 找 Electron / Node
# ---------------------------------------------------------------------------
$appDir = Join-Path $root 'app'
$electron = Join-Path $appDir 'node_modules\electron\dist\electron.exe'

function Find-Node {
  $candidates = @()
  $runtime = Join-Path $root 'runtime'
  if (Test-Path $runtime) {
    $candidates += Get-ChildItem -Path $runtime -Directory -Filter 'node-v*-win-x64' -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'node.exe' }
  }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return $null
}

# 用来调用我们自己的 .ps1（必须是 Windows PowerShell 5.1，见文件头那两条规则）
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $psExe)) { $psExe = 'powershell.exe' }

# 别让 DSH / 编辑器注入的变量把 Electron 变成"纯 Node"（那样窗口永远不会出现）
$env:ELECTRON_RUN_AS_NODE = $null
$env:NODE_OPTIONS = $null

# 临时目录收进项目里，不往系统 Temp 写东西
$tmp = Join-Path $root 'runtime\tmp'
if (-not (Test-Path $tmp)) { [void](New-Item -ItemType Directory -Force -Path $tmp) }
$env:TEMP = $tmp
$env:TMP = $tmp

# ---------------------------------------------------------------------------
# 跑一次 Electron 并**拿到它的退出码**（下面 -Check 和正式启动都要用）
# ---------------------------------------------------------------------------
# ★ 为什么不能用 `& $electron ...` 或 `Start-Process -Wait`：
#   electron.exe 是 Windows 的"GUI 子系统"程序（自己不带控制台），PowerShell 用
#   & 调它时**根本不等**，也不设置 $LASTEXITCODE；`2>&1` 也抓不到它的输出。
#   只有 .NET 的 Process API 能把"等它结束 / 拿退出码 / 收它的 stdout+stderr"
#   这三件事都办到。第一版启动器就是踩了这个坑：双击后黑窗口自己关掉、
#   看着像什么都没发生，下面那整段诊断代码永远跑不到。
function New-ElectronStartInfo([string]$argumentLine) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $electron
  $psi.Arguments = $argumentLine
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false        # 继承当前控制台与环境变量
  return $psi
}

# 同步跑一次（用于 -Check 里的 --version 体检），返回 @{ Code=..; Out=..; TimedOut=.. }
function Invoke-Electron([string]$argumentLine, [int]$timeoutMs) {
  $psi = New-ElectronStartInfo $argumentLine
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($timeoutMs)) {
    try { $p.Kill() } catch { }
    return @{ Code = $null; Out = ''; TimedOut = $true }
  }
  $text = ''
  try { $text = (($outTask.Result + $errTask.Result)).Trim() } catch { }
  return @{ Code = $p.ExitCode; Out = $text; TimedOut = $false }
}

function Format-HexCode($code) {
  if ($null -eq $code) { return '（无退出码）' }
  return ('0x' + ('{0:X8}' -f ($code -band 0xFFFFFFFF)))
}

# ---------------------------------------------------------------------------
# -Check：只体检
# ---------------------------------------------------------------------------
if ($Check) {
  Say '【环境体检】' 'Cyan'
  Say ("  项目根目录 : " + $root)
  Say ("  Electron   : " + $electron + "  " + $(if (Test-Path $electron) { 'OK' } else { '缺失' }))
  $node = Find-Node
  Say ("  Node       : " + $(if ($node) { $node } else { '没找到' }))
  Say ("  临时目录   : " + $tmp)
  $engineModules = Join-Path $root 'vendor\mindcraft-develop\node_modules'
  $appModules = Join-Path $appDir 'node_modules'
  Say ("  引擎依赖   : " + $engineModules + "  " + $(if (Test-Path $engineModules) { 'OK' } else { '缺失' }))
  Say ("  应用依赖   : " + $appModules + "  " + $(if (Test-Path $appModules) { 'OK' } else { '缺失' }))
  Say '  （上面任何一项缺失，双击 启动.cmd 都会先自动下载补齐；也可以手动跑 tools\bootstrap.mjs）'

  # ★ Electron 自检：不只问"文件在不在"，而是**真的跑一次**。因为最常见的故障
  #   （Chromium 沙箱被安全软件/内存完整性拦住）表现是"文件明明在，一跑就崩"。
  if (Test-Path $electron) {
    Say ''
    Say '【Electron 能不能起来】' 'Cyan'
    $normal = Invoke-Electron '--version' 30000
    if ($normal.Code -eq 0) {
      Say ('  带沙箱启动   : OK（' + $normal.Out + '）') 'Green'
    } else {
      Say ('  带沙箱启动   : 起不来，退出码 ' + (Format-HexCode $normal.Code)) 'Yellow'
      $fb = Invoke-Electron '--version --no-sandbox' 30000
      if ($fb.Code -eq 0) {
        Say ('  关掉沙箱启动 : OK（' + $fb.Out + '）') 'Yellow'
        Say '  → 这台机器上 Chromium 的沙箱起不来（多半是安全软件，或系统的「内存完整性」）。' 'Yellow'
        Say '     不影响使用：双击 启动.cmd 时程序会自动改用「关掉沙箱」的方式，界面照样出得来。' 'Yellow'
      } else {
        Say ('  关掉沙箱启动 : 也起不来，退出码 ' + (Format-HexCode $fb.Code)) 'Red'
        Say '     Electron 本身有问题：删掉 app\node_modules\electron 再 npm install 一次。' 'Red'
      }
    }
  }

  # ★ 依赖清单交给 bootstrap 自己报（它就是"缺什么、下多大"的唯一权威）：
  #   这样"双击起不来"时只要跑一次 -Check，就能一次看全 —— 而不是只看到
  #   "找不到 Electron"然后自己猜。
  if ($node) {
    $bs = Join-Path $PSScriptRoot 'bootstrap.mjs'
    if (Test-Path $bs) {
      Say ''
      Say '【依赖清单（tools\bootstrap.mjs --check）】' 'Cyan'
      & $node $bs --check
      $bsCode = $LASTEXITCODE
      if ($bsCode -eq 0) { Say '  → 依赖齐全' 'Green' } else { Say '  → 还缺东西（双击 启动.cmd 会自动下载补齐）' 'Yellow' }
    }
  }

  if ((Test-Path $electron) -or $node) { exit 0 } else { exit 1 }
}

# ---------------------------------------------------------------------------
# -Preview：浏览器里看界面（演示数据模式）
# ---------------------------------------------------------------------------
if ($Preview) {
  $node = Find-Node
  if (-not $node) { Fail @('找不到 Node.js。', '项目里的 runtime\node-v*-win-x64\node.exe 应该存在；不在的话请重新解压一份完整项目。') }
  $server = Join-Path $root 'tools\preview-server.mjs'
  if (-not (Test-Path $server)) { Fail @('找不到 tools\preview-server.mjs，项目文件不完整。') }

  Say '正在启动界面预览（演示数据模式）…' 'Cyan'
  Say '浏览器打开后就是这个应用的样子；关掉这个窗口预览就停了。'
  Say ''
  try { Start-Process 'http://127.0.0.1:8899/' } catch { Say '（浏览器没自动打开，请手动访问 http://127.0.0.1:8899/ ）' 'Yellow' }
  & $node $server 8899
  exit $LASTEXITCODE
}

# ---------------------------------------------------------------------------
# 默认：启动桌面应用
# ---------------------------------------------------------------------------
# ★ 依赖自检：从 GitHub 下载的源码里**没有**三样大东西 ——
#   Node 运行时（约 95 MB）、引擎依赖 vendor\mindcraft-develop\node_modules（约 714 MB）、
#   Electron（约 380 MB）。它们都被 .gitignore 排除了（一个仓库不可能带 1.2 GB 依赖）。
#   以前这里只报"找不到 Electron，请自己 cd app && npm install"—— 对不写代码的人来说
#   等于"到这里就没了"。现在启动器自己把这一步走完：先确保有 Node（没有就用
#   tools\install-node.ps1 下一份），再交给 tools\bootstrap.mjs 装剩下的。
$bs = Join-Path $PSScriptRoot 'bootstrap.mjs'
$depsOk = $false
if ($node -and (Test-Path $bs)) {
  # 静默体检：全齐就一个字都不多说（正常用户永远不会看到下面这一大段）
  & $node $bs --check *> $null
  if ($LASTEXITCODE -eq 0) { $depsOk = $true }
}
if (-not $depsOk) {
  Say ''
  Say '这台电脑上还缺运行需要的东西，需要联网下载（第一次启动才要，约 460 MB）。' 'Cyan'
  Say '已经下好的部分不会重复下载，中途断了再双击一次 启动.cmd 会接着装。'
  Say ''

  # ★ 跑 bootstrap 之前先看它一眼：这个脚本自己坏掉时（下载不完整、或者被编辑器
  #   按 GBK 存坏过一遍 —— 实测踩过一次，整份文件的中文和换行一起没了），Node 抛的
  #   是 SyntaxError，而上面那句"缺依赖"会把它盖成"依赖没补齐"。这两种情况的处理
  #   方式完全不同：一个要重新下载源码，一个是网络问题。所以要分开说清楚。
  if ($node -and (Test-Path $bs)) {
    $syntaxOut = (& $node --check $bs 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
      $why = @(
        '项目文件坏了：tools\bootstrap.mjs 不是一个有效的 JavaScript 文件。',
        '',
        'Node 的原话：'
      )
      $why += (($syntaxOut -split "`r?`n") | Select-Object -First 5 | ForEach-Object { '    ' + $_ })
      $why += ''
      $why += '多半是源码下载 / 解压不完整，或者用记事本之类的编辑器保存过它（UTF-8 中文被当成 GBK 存坏）。'
      $why += '请重新下载一份完整源码，整个解压后覆盖本目录即可（配置文件在 runtime\ 下，不会被覆盖）。'
      Fail $why
    }
  }

  if (-not $node) {
    $installer = Join-Path $PSScriptRoot 'install-node.ps1'
    if (-not (Test-Path $installer)) {
      Fail @(
        '项目文件不完整：缺少 tools\install-node.ps1，没法自动装 Node 运行时。',
        '',
        '如果你是从 GitHub 下载的 zip，请确认整个压缩包都解压出来了（不是只拖了里面几个文件）。'
      )
    }
    Say '第 1 步 · 下载 Node 运行时（引擎要求 Node 22）' 'Cyan'
    & $psExe -NoProfile -ExecutionPolicy Bypass -File $installer
    if ($LASTEXITCODE -ne 0) {
      Fail @(
        'Node 运行时没装上（上面是下载器的原话）。',
        '',
        '要联网。连上网之后再双击一次 启动.cmd 就行 —— 已经下好的部分不会重复下。'
      )
    }
    $node = Find-Node
    if (-not $node) { Fail @('Node 解压完了但还是找不到 node.exe —— 请把上面窗口的内容截图发我。') }
    Say ''
  }

  if (-not (Test-Path $bs)) {
    Fail @(
      '项目文件不完整：缺少 tools\bootstrap.mjs，没法自动补引擎依赖。',
      '',
      '请重新从 GitHub 下载一份完整源码。'
    )
  }
  Say '第 2 步 · 下载引擎依赖和界面运行时（约 430 MB，这一步最慢）' 'Cyan'
  & $node $bs
  if ($LASTEXITCODE -ne 0) {
    Fail @(
      '依赖没补齐（上面是它们自己报的原因）。',
      '',
      '把上面窗口的完整内容截图发我，我接着查。',
      '要联网；已经下好的部分不会重复下载，网络好了再双击一次 启动.cmd 就会接着装。'
    )
  }
}

if (-not (Test-Path $electron)) {
  $lines = @()
  $lines += '依赖装完了，但还是找不到 Electron，界面起不来。'
  $lines += ''
  $lines += ('  期望的位置：' + $electron)
  $lines += ''
  $lines += '请在命令行里手动跑一次，看它报什么错：'
  $lines += ('      cd /d "' + $root + '"')
  $lines += '      runtime\node-v22.23.3-win-x64\node.exe tools\bootstrap.mjs'
  $lines += ''
  $lines += '（如果项目是从别处拷贝过来的，注意 node_modules 常常不会被一起拷。）'
  Fail $lines
}

$exeSize = 0
try { $exeSize = (Get-Item $electron).Length } catch { }
if ($exeSize -gt 0 -and $exeSize -lt 1000000) {
  Fail @(
    'Electron 那个文件小得不像话，多半是下载没下完（半截文件）。',
    ('  路径：' + $electron),
    ('  大小：' + $exeSize + ' 字节（正常应该是 2 亿字节左右）'),
    '',
    '双击一次 启动.cmd 会自动重装；也可以在命令行里跑 tools\bootstrap.mjs（加 --force 会强制重下）。'
  )
}

Say '正在启动 MC 陪伴机器人…' 'Cyan'
Say '（这个黑色窗口会一直留着 —— 它就是程序的"开关"，关掉它等于关掉整个程序）'
Say ''

# ★ 启动分两次尝试：第一次保留 Chromium 沙箱，第二次才关掉它。
#   为什么要这样：这台机器（Windows 11 + 腾讯电脑管家在跑 + 内存完整性开启）上，
#   Chromium 的沙箱在**启动第一步**就失败，Electron 用 0x80000003
#   （STATUS_BREAKPOINT —— Chromium 的 CHECK 失败就是这么表达的）立刻退出，
#   窗口根本来不及出现。实测证据：连 `electron.exe --version` 都是 0x80000003，
#   而 `electron.exe --version --no-sandbox` 打印 v44.5.1、一切正常；
#   加上 --no-sandbox 跑本应用，窗口标题「MC 陪伴机器人」正常出现。
#   既然它崩在 1 秒内，就先探 8 秒：崩了自动换一种方式再来，而不是把一份
#   "0x80000003 的常见原因"甩给用户让他自己去猜。
#   （为什么必须用 .NET 的 Process API：见上面 New-ElectronStartInfo 的注释。）
$SANDBOX_CRASH = 0x80000003
$code = 0
$usedNoSandbox = $false
$proc = $null
for ($attempt = 0; $attempt -lt 2; $attempt++) {
  $extra = ''
  if ($attempt -eq 1) { $extra = '--no-sandbox' }
  $psi = New-ElectronStartInfo ('"' + $appDir + '"' + $(if ($extra) { ' ' + $extra } else { '' }))
  $proc = [System.Diagnostics.Process]::Start($psi)

  if (-not $proc.WaitForExit(8000)) {
    # 8 秒还活着 = 窗口已经出来了。之后就一直等它（用户关掉窗口时它才结束）。
    $proc.WaitForExit()
    $code = $proc.ExitCode
    if ($null -eq $code) { $code = 0 }
    break
  }

  $code = $proc.ExitCode
  if ($null -eq $code) { $code = 0 }

  if ((($code -band 0xFFFFFFFF) -eq $SANDBOX_CRASH) -and ($attempt -eq 0)) {
    $usedNoSandbox = $true
    Say ''
    Say '这台电脑上 Chromium 的沙箱起不来：Electron 在启动第一步就退出了（0x80000003）。' 'Yellow'
    Say '现在自动换一种方式再启动一次（关掉沙箱）—— 窗口这次应该能出来。' 'Yellow'
    Say '跟你填的服务器地址、API Key 没关系，也没有改动你的任何配置。'
    Say ''
    continue
  }
  break
}

if ($code -ne 0) {
  Say ''
  # Windows 的异常退出码是"负数"（0x80000000 以上按有符号读）。看到这种码就说明
  # 崩的是 Electron 自己，跟用户在应用里填的服务器 / API Key 一点关系都没有 ——
  # 这种时候列"检查你的服务器地址"纯属误导，要分开说。
  $unsigned = $code -band 0xFFFFFFFF
  if ($unsigned -ge 0x80000000) {
    $hex = '{0:X8}' -f $unsigned
    if ($usedNoSandbox) {
      Say ('关掉沙箱之后 Electron 还是没能启动（退出码 0x' + $hex + '）。') 'Red'
      Say ''
      Say '把上面这个窗口的完整内容截图发我，我接着查。'
      Say '（这条路径已经排除了"沙箱被拦"这个最常见的原因。）'
      Pause-IfNeeded
      exit $code
    }
    Say ('Electron 自己没能启动起来（退出码 0x' + $hex + '）。') 'Red'
    Say ''
    Say '这不是你填的服务器地址或 API Key 的问题 —— 程序还没来得及读配置就退出了。'
    Say '常见原因：'
    Say '  · 安全软件拦了 Chromium 的沙箱（腾讯电脑管家 / 360 / 火绒…把它加进信任名单）'
    Say '  · 系统的「内存完整性」开着（Windows 安全中心 → 设备安全性 → 内核隔离）'
    Say '  · 在远程桌面 / 虚拟机里运行：显卡虚拟化不支持，换个本机桌面再试'
    Say '  · 系统缺 VC++ 运行库（装一次 Visual C++ Redistributable 2015-2022 x64）'
    Say '  · Electron 下载不完整：删掉 app\node_modules\electron 再 npm install'
    Say ''
    Say '想看这台机器到底是哪一条，跑一次体检（不启动界面）：'
    Say ('    powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'launch-gui.ps1') + '" -Check')
  } else {
    Say ('程序自己退出了，退出码 ' + $code) 'Yellow'
    Say '常见原因（按可能性排）：'
    Say '  · 同一个 MC 账号已经被别处登着 —— 服务器会把新的踢下线'
    Say '  · 服务器地址或端口填错了、服务器没开'
    Say '  · 大模型 API Key 没填或填错（在「模型」页填，填完点一下「测试」）'
    Say ''
    Say '应用里的「日志」页有更详细的中文说明。'
  }
  Pause-IfNeeded
}

exit $code
