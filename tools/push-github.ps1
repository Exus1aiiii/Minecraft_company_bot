# ============================================================================
#  tools\push-github.ps1 —— 双击 推送到GitHub.cmd 会跑这个
#
#  为什么单独写一个脚本（这是用户报障换来的，不是多此一举）：
#     报障原文：Failed to connect to github.com:443 after 21101 ms: Could not connect to server
#     真相既不是 GitHub 挂了，也不是仓库配错了，而是**流量没有走代理**：
#       · 这台机器上代理软件开着，混合端口 127.0.0.1:7897；
#       · Windows 的「系统代理」开关是关的（ProxyEnable=0），而 git **不看**系统代理设置
#         —— 它只认 http.proxy / https_proxy 或环境变量，于是 git 直连 github.com:443，
#         在现在的网络下就是 20 秒后超时。
#     所以修法不是"每次记得开系统代理"，而是让 git 自己认这个代理。本脚本会：
#       ① 幂等地把本仓库的 GitHub 请求指到 socks5h://127.0.0.1:7897；
#       ② 推之前先探一次这个端口 —— 代理没开时立刻告诉你，而不是白等 20 秒；
#       ③ 按报错内容说人话；遇到这台机器特有的 schannel 报错会自动换 openssl 后端再试一次；
#       ④ 没有新提交时不瞎推，直接说"已经是最新的"。
#     想撤销本脚本写进 .git/config 的两条设置：
#       git config --local --unset "http.https://github.com/.proxy"
#       git config --local --unset http.sslBackend
#
#  退出码：0 = 成功（含"没有要推的"） 1 = 推送失败 2 = 代理没在跑
# ============================================================================

#  -DryRun     只检查（有没有要推的、代理在不在），不真的推送
#  -ProxyPort  代理软件的混合端口，默认 7897 —— 端口不一样时不用改这个文件：
#              推送到GitHub.cmd -ProxyPort 10808
param(
    [switch]$DryRun,
    [string]$ProxyHost = '127.0.0.1',
    [int]$ProxyPort = 7897
)

$ErrorActionPreference = 'Continue'

# ★ 严格模式是故意的：这个脚本第一次写出来时，探端口那一行漏改成新变量名
#   （`Test-TcpPort $PROXY_HOST $PROXY_PORT`，改完参数后这两个变量已经是空的），
#   于是探端口永远返回 false，脚本每次都报"代理没在跑"—— 而窗口里一个字都不提原因。
#   严格模式会让"用了没定义的变量"当场报错，而不是安静地变成 $null。
Set-StrictMode -Version 2.0

$root = Split-Path -Parent $PSScriptRoot

function Say([string]$text, [string]$color = 'Gray') {
    Write-Host $text -ForegroundColor $color
}

# ★ 必须自己探端口，不能靠 Test-NetConnection：后者对"关着的端口"要等好几秒。
function Test-TcpPort([string]$ComputerName, [int]$Port, [int]$TimeoutMs = 2000) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($ComputerName, $Port, $null, $null)
        if ($async.AsyncWaitHandle.WaitOne($TimeoutMs)) { $client.EndConnect($async); return $true }
        return $false
    } catch { return $false } finally { $client.Close() }
}

# -Stream：把 git 的输出**同时**实时打到窗口并收集起来（Tee-Object）。
# 推送那两步必须用流式：第一次推送会弹 Git Credential Manager 去浏览器授权，
# 如果输出被攒着不显示，用户看到的是一个"卡住了"的黑窗口，不知道该不该关掉。
function Invoke-Git([string[]]$GitArgs, [switch]$Stream) {
    if ($Stream) {
        $null = & git -C $root @GitArgs 2>&1 | Tee-Object -Variable captured
        $code = $LASTEXITCODE
        return [pscustomobject]@{ Output = (($captured | Out-String).Trim()); Code = $code }
    }
    $raw = & git -C $root @GitArgs 2>&1
    $code = $LASTEXITCODE
    return [pscustomobject]@{ Output = (($raw | Out-String).Trim()); Code = $code }
}

Say ''
Say '  === 推送到 GitHub ===' 'Cyan'
Say "  仓库：$root"

if (-not (Test-Path (Join-Path $root '.git'))) {
    Say '  ✗ 这里不是 git 仓库（找不到 .git 目录）。' 'Red'
    exit 1
}

# ── ① 有没有要推的 ─────────────────────────────────────────────────────────
$count = Invoke-Git @('rev-list', '--count', 'origin/main..HEAD')
$ahead = 0
[void][int]::TryParse((($count.Output -replace '\D', '') -as [string]), [ref]$ahead)
if ($count.Code -ne 0) {
    Say '  ✗ 读不到远端状态 —— 先跑一次：git fetch origin' 'Red'
    if ($count.Output) { Say $count.Output 'DarkGray' }
    exit 1
}
if ($ahead -le 0) {
    Say '  ✓ 本地没有新提交，远端已经是最新的 —— 不用推。' 'Green'
    exit 0
}
Say "  待推送：$ahead 个提交" 'Yellow'
$log = Invoke-Git @('log', '--oneline', 'origin/main..HEAD')
if ($log.Output) { Say $log.Output 'DarkGray' }

# ── ② 代理在不在（先探再推：省掉那 20 秒的干等）─────────────────────────────
Say ''
if (Test-TcpPort $ProxyHost $ProxyPort) {
    Say "  ✓ 代理在跑（${ProxyHost}:${ProxyPort}）" 'Green'
} else {
    Say "  ✗ 代理端口 ${ProxyHost}:${ProxyPort} 连不上。" 'Red'
    Say '    这个仓库的 git 已经配置成走它，所以请先把代理软件（Clash / VPN）打开，' 'Yellow'
    Say '    确认它的混合端口是 7897，然后双击一次本脚本。' 'Yellow'
    Say '    端口不是 7897 的话，重新双击时带上端口即可（不用改脚本）：' 'Yellow'
    Say '      推送到GitHub.cmd -ProxyPort <端口>' 'DarkGray'
    exit 2
}

# ── ③ 幂等地保证"这个仓库的 GitHub 请求走代理" ─────────────────────────────
#    ★ 顺序是故意的：**先探通再写配置**。反过来的话，用户把端口填错一次（比如填成
#      没开的 7890）就会把这个错端口永久写进 .git/config —— 之后他自己手敲 git push
#      也会被指到一个死端口上，比原来还难查。实测就是这么发现的：负数验证跑完
#      `-ProxyPort 7890` 之后，`.git/config` 里真的留下了 7890。
#    幂等也是必须的：用户换端口、或在别的机器上 clone 之后第一次跑，两次结果必须一样，
#    且不能覆盖掉他其它主机的设置（所以只写 github.com 这一条）。
$wantProxy = "socks5h://${ProxyHost}:${ProxyPort}"
$curProxy = (Invoke-Git @('config', '--local', '--get', 'http.https://github.com/.proxy')).Output
if ($curProxy -ne $wantProxy) {
    Invoke-Git @('config', '--local', 'http.https://github.com/.proxy', $wantProxy) | Out-Null
    Say "  · 已设置本仓库的 GitHub 代理：$wantProxy" 'DarkGray'
}

if ($DryRun) {
    Say ''
    Say '  (-DryRun：只检查，不真的推送)' 'DarkGray'
    exit 0
}

# ── ④ 推 ───────────────────────────────────────────────────────────────────
Say ''
Say '  正在推送…（第一次会让你在浏览器里登录 GitHub，按提示点一下就行）' 'Cyan'
$push = Invoke-Git @('push', 'origin', 'main') -Stream

# ★ 这台机器特有的坑：schannel 拿不到凭证句柄（SEC_E_NO_CREDENTIALS）。
#   跟启动器遇到 0x80000003 就自动换 --no-sandbox 是同一个套路：先按默认来，撞上已知
#   环境问题就换一条能走通的路再试一次，而不是把环境问题当成"用户配错了"。
if ($push.Code -ne 0 -and $push.Output -match 'schannel') {
    Say ''
    Say '  · Windows 的 TLS 通道读不到证书 —— 改成 openssl 后端再试一次' 'Yellow'
    Invoke-Git @('config', '--local', 'http.sslBackend', 'openssl') | Out-Null
    $push = Invoke-Git @('push', 'origin', 'main') -Stream
}

if ($push.Code -eq 0) {
    $head = (Invoke-Git @('rev-parse', '--short', 'HEAD')).Output
    Say ''
    Say "  ✓ 推送完成，远端现在是 $head" 'Green'
    exit 0
}

Say ''
Say '  ✗ 推送失败。按报错内容对照处理：' 'Red'
$text = $push.Output
if (-not $text) { $text = '(git 没有输出 —— 上面窗口里的内容就是线索)' }
if ($text -match 'could not read Username|Authentication failed|Invalid username or password|terminal prompts disabled') {
    Say '    · 需要登录 GitHub：正常会弹出窗口（Git Credential Manager）让你在浏览器里授权。' 'Yellow'
    Say '      弹不出来就用「个人访问令牌」当密码：用户名填 Exus1aiiii，密码填令牌' 'Yellow'
    Say '      （GitHub → Settings → Developer settings → Personal access tokens，勾 repo 或 Contents: Read and write）。' 'Yellow'
}
if ($text -match 'Failed to connect|Could not connect to server|Connection refused|Connection timed out|unexpected eof') {
    Say '    · 还是连不上 GitHub：确认代理在跑、端口对得上（当前 7897）。' 'Yellow'
}
if ($text -match 'rejected|non-fast-forward|fetch first') {
    Say '    · 远端有你本地没有的提交：先 git pull --rebase origin main，再推一次。' 'Yellow'
}
if ($text -match 'Everything up-to-date') {
    Say '    · 其实没有要推的东西（本地和远端一致）。' 'Yellow'
}
exit 1
