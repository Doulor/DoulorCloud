<#
.SYNOPSIS
  DoulorCloud · 代理节点（内网穿透）一键捐献脚本 · Windows 版

.DESCRIPTION
  和 Linux 版做同样的事：装依赖 → 下载 frps 和面板 → 生成配置 → 拉起并保活 →
  自检 → 自检通过才回报登记。

  用法（在**管理员** PowerShell 里）：
      irm https://pub-4362b2869bc5460aa18128ac9126e59c.r2.dev/install/frp-node.ps1 -OutFile $env:TEMP\frp-node.ps1
      powershell -ExecutionPolicy Bypass -File $env:TEMP\frp-node.ps1 -Ip <你的IPv4> -Token <捐献令牌>

  Windows 上没有 systemd，用「计划任务 + 开机启动 + 失败重启」来保活。选它而不是
  sc.exe 建服务，是因为服务要求可执行文件本身支持服务控制协议，而面板是个 Python
  脚本，套服务需要额外的 wrapper；计划任务直接跑进程，简单且够用。

.NOTES
  ⚠️ 自检通过才回报 —— 和 Linux 版同一条原则：登记一台没跑起来的节点，
     只会在后台留下连不上的死节点，还要人去查。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Ip,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$ApiBase = "https://cloud.doulor.cn",
  [string]$PanelUrl = "",
  [int]$FrpsPort = 7000,
  [int]$PanelPort = 7200
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # 关掉进度条，能让 Invoke-WebRequest 快好几倍

$InstallDir = Join-Path $env:ProgramData "DoulorFrpNode"
$FrpsVersion = "0.65.0"
# 面板和 frps 都从 R2 的公共只读地址取。刻意**不**走 cloud.doulor.cn 的 Worker 路由：
# 那样会在安装链路上多一个我们自己代码的依赖点 —— 面板挂了这个脚本就装不了。
# R2 是静态托管，和站点故障域分开，安装的成功率更高。
$CdnBase = if ($env:DOULOR_CDN_BASE) { $env:DOULOR_CDN_BASE } else { "https://pub-4362b2869bc5460aa18128ac9126e59c.r2.dev" }
if (-not $PanelUrl) { $PanelUrl = "$CdnBase/install/frp-node-panel.py" }

function Say($m)  { Write-Host $m }
function Ok($m)   { Write-Host "✓ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

Say ""
Say "DoulorCloud · 代理节点一键捐献（Windows）"
Say "--------------------------------------------"

# ---------------------------------------------------------------- 前置检查
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Die "请用**管理员** PowerShell 运行（要写 ProgramData 和建计划任务）。" }

# IPv4 形状校验 —— 提前挡住手滑，别跑一半才报错
$parts = $Ip.Split(".")
if ($parts.Count -ne 4) { Die "「$Ip」不是 IPv4 地址（要有 4 段）。" }
foreach ($p in $parts) {
  if ($p -notmatch '^\d{1,3}$') { Die "IPv4 段「$p」不是数字。" }
  if ([int]$p -lt 0 -or [int]$p -gt 255) { Die "IPv4 段「$p」超出 0-255。" }
}
Ok "IPv4 格式正确：$Ip"

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
Ok "架构：$env:PROCESSOR_ARCHITECTURE → frp_$arch"
Ok "系统：$([System.Environment]::OSVersion.VersionString)"

# ---------------------------------------------------------------- Python
function Find-Python {
  foreach ($c in @("python", "python3", "py")) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) {
      try {
        $v = & $c -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -eq 0 -and $v) { return @{ Exe = $c; Ver = $v } }
      } catch { }
    }
  }
  return $null
}

$py = Find-Python
if (-not $py) {
  Warn "没找到 Python。尝试用 winget 自动安装…"
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    try {
      winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements --silent | Out-Null
      $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                  [System.Environment]::GetEnvironmentVariable("Path", "User")
      $py = Find-Python
    } catch { }
  }
}
if (-not $py) {
  Die "没有 Python。请先装 Python 3.6+：https://www.python.org/downloads/ （安装时勾选 Add to PATH），然后重跑本脚本。"
}
$pyVer = $py.Ver
$pyExe = (Get-Command $py.Exe).Source
if ([version]("$pyVer.0") -lt [version]"3.6.0") { Die "需要 Python 3.6 或更高（当前 $pyVer）。" }
Ok "Python $pyVer  ($pyExe)"

# ---------------------------------------------------------------- 端口
function Test-PortUsed([int]$p) {
  try { return $null -ne (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }
  catch { return $false }
}
function Get-FreePort([int]$p) {
  while (Test-PortUsed $p) { Warn "端口 $p 被占用，换一个"; $p++ ; if ($p -gt 65000) { Die "找不到可用端口" } }
  return $p
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$cfgPath = Join-Path $InstallDir "panel.json"

if (Test-Path $cfgPath) {
  # 已装过：沿用旧端口，避免每次重跑配置漂移（面板和 frps 就对不上了）
  $old = Get-Content $cfgPath -Raw | ConvertFrom-Json
  $PanelPort = [int]$old.listen_port
  $frpsCfg = Join-Path $InstallDir "frps.toml"
  if (Test-Path $frpsCfg) {
    $m = Select-String -Path $frpsCfg -Pattern '^bindPort\s*=\s*(\d+)' | Select-Object -First 1
    if ($m) { $FrpsPort = [int]$m.Matches[0].Groups[1].Value }
  }
  Ok "检测到已有安装，沿用端口：frps=$FrpsPort 面板=$PanelPort"
} else {
  $FrpsPort = Get-FreePort $FrpsPort
  $PanelPort = Get-FreePort $PanelPort
  if ($PanelPort -eq $FrpsPort) { $PanelPort = Get-FreePort ($PanelPort + 1) }
  Ok "选定端口：frps=$FrpsPort 面板=$PanelPort"
}

Set-Location $InstallDir

# ---------------------------------------------------------------- 下载
Say "下载 frps $FrpsVersion…"
$tarball = "frp_${FrpsVersion}_windows_${arch}.zip"
$url = "https://github.com/fatedier/frp/releases/download/v$FrpsVersion/$tarball"
$zip = Join-Path $env:TEMP $tarball
try {
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 300
} catch {
  Die "下载 frps 失败：$($_.Exception.Message)`n若在国内，GitHub 可能被墙 —— 配好代理后重跑。"
}
$tmp = Join-Path $env:TEMP ("doulorfrp_" + [guid]::NewGuid().ToString("N").Substring(0, 8))
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$frpsSrc = Get-ChildItem -Path $tmp -Recurse -Filter "frps.exe" | Select-Object -First 1
if (-not $frpsSrc) { Die "压缩包里没找到 frps.exe" }
Copy-Item $frpsSrc.FullName (Join-Path $InstallDir "frps.exe") -Force
Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
Ok "frps 已就位"

Say "下载面板…"
$panelPath = Join-Path $InstallDir "panel.py"
try {
  Invoke-WebRequest -Uri $PanelUrl -OutFile $panelPath -UseBasicParsing -TimeoutSec 120
} catch {
  Die "下载面板失败：$PanelUrl —— $($_.Exception.Message)"
}
if ((Get-Content $panelPath -TotalCount 1) -notmatch 'python') {
  Die "下载到的面板不像 Python 脚本（可能被网络中间页替换了）"
}
Ok "面板 $( (Get-Item $panelPath).Length ) 字节"

# ---------------------------------------------------------------- 配置
if (Test-Path $cfgPath) {
  Ok "沿用已有面板配置"
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
} else {
  Say "生成配置…"
  function New-Secret([int]$n) {
    $chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".ToCharArray()
    $bytes = New-Object byte[] $n
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
  }
  $frpsToken = New-Secret 32
  $panelPw = New-Secret 24
  $agentSecret = New-Secret 40

  $frpsToml = @"
bindPort = $FrpsPort

# 仪表盘只监听回环：它自带的鉴权很弱，不能暴露到公网。
webServer.addr = "127.0.0.1"
webServer.port = $($PanelPort + 100)
webServer.user = "admin"
webServer.password = "$(New-Secret 24)"

auth.method = "token"
auth.token = "$frpsToken"
# 客户端和服务端都要声明这两个作用域，Ping 心跳才会回调插件 —— 到期踢人靠的是它
# （HeartBeats 的 B 是大写，写错就静默失效）。
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]

[[httpPlugins]]
name = "doulor-panel"
addr = "127.0.0.1:$PanelPort"
path = "/handler"
ops = ["Login", "NewProxy", "CloseProxy", "Ping", "NewWorkConn", "NewUserConn"]
"@
  [System.IO.File]::WriteAllText((Join-Path $InstallDir "frps.toml"), $frpsToml, (New-Object System.Text.UTF8Encoding $false))

  $cfg = [ordered]@{
    listen_host                = "0.0.0.0"
    listen_port                = $PanelPort
    allow_public_bind          = $true
    data_file                  = (Join-Path $InstallDir "accounts.json")
    log_file                   = (Join-Path $InstallDir "panel.log")
    user_prefix                = "DC_"
    agent_secret               = $agentSecret
    admin_user                 = "admin"
    admin_password             = $panelPw
    session_secret             = (New-Secret 40)
    frps_public_addr           = $Ip
    frps_bind_port             = $FrpsPort
    frps_global_token          = $frpsToken
    default_rental_days        = 30
    default_port_start         = 10000
    default_port_end           = 10010
    expiring_soon_days         = 3
    auto_disable_expired       = $false
    sweep_interval_seconds     = 300
  }
  $json = $cfg | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding $false))

  $cred = @"
DoulorCloud 代理节点 · 本机凭据
面板地址   http://${Ip}:$PanelPort
面板用户名 admin
面板口令   $panelPw
frps 端口  $FrpsPort
frps token $frpsToken
agent 密钥 $agentSecret
"@
  [System.IO.File]::WriteAllText((Join-Path $InstallDir "credentials.txt"), $cred, (New-Object System.Text.UTF8Encoding $false))
  Ok "配置已生成（凭据在 $InstallDir\credentials.txt）"
}

$frpsToken = $cfg.frps_global_token
$panelPw = $cfg.admin_password
$agentSecret = $cfg.agent_secret

# ---------------------------------------------------------------- 计划任务（保活）
Say "注册开机自启…"
function Register-NodeTask([string]$name, [string]$exe, [string]$args) {
  $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
  $action = New-ScheduledTaskAction -Execute $exe -Argument $args -WorkingDirectory $InstallDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  # 失败无限重启：这是保活的关键，不然机器重启后半死不活的进程会一直挂着
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName $name
}

Register-NodeTask "DoulorFrpPanel" $pyExe "`"$panelPath`" --config `"$cfgPath`""
Start-Sleep -Seconds 1
Register-NodeTask "DoulorFrps" (Join-Path $InstallDir "frps.exe") "-c `"$(Join-Path $InstallDir 'frps.toml')`""
Ok "计划任务已注册并启动"

# ---------------------------------------------------------------- 自检
Say ""
Say "自检中…"
$deadline = (Get-Date).AddSeconds(30)
$panelOk = $false; $frpsOk = $false
while ((Get-Date) -lt $deadline) {
  if (-not $panelOk) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$PanelPort/health" -UseBasicParsing -TimeoutSec 4
      if ($r.Content -match '"ok"') { $panelOk = $true; Ok "面板 /health 正常" }
    } catch { }
  }
  if (-not $frpsOk) {
    if (Test-PortUsed $FrpsPort) { $frpsOk = $true; Ok "frps 正在监听 $FrpsPort" }
  }
  if ($panelOk -and $frpsOk) { break }
  Start-Sleep -Seconds 2
}

if (-not $panelOk) { Get-Content (Join-Path $InstallDir "panel.log") -Tail 20 -ErrorAction SilentlyContinue; Die "面板没起来（上面是它的日志）。" }
if (-not $frpsOk) { Die "frps 没在监听 $FrpsPort。" }

try {
  $h = Invoke-WebRequest -Uri "http://127.0.0.1:$PanelPort/health" -UseBasicParsing -TimeoutSec 5
  if ($h.Content -notmatch 'accounts') { Die "面板 /health 不含账号信息，数据文件可能有问题。" }
} catch { Die "面板健康检查失败。" }
Ok "面板能读到账号数据"

# ---------------------------------------------------------------- 防火墙
#
# ⚠️ 云厂商的「安全组 / 网络 ACL」在厂商那一侧，服务器内部读不到
#    （没有厂商 API 凭据），所以那一半只能给清单让用户自己去控制台开。
#    但本机 Windows 防火墙这一半能自动做掉，就顺手做掉 —— 少一个让捐献失败的坑。
Say ""
Say "检查本机防火墙…"
$fwOpened = @()
foreach ($p in @($FrpsPort, $PanelPort)) {
  $ruleName = "Doulor frp $p"
  try {
    if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
        -LocalPort $p -Action Allow -Profile Any -ErrorAction Stop | Out-Null
      $fwOpened += $p
    }
  } catch {
    Warn "防火墙规则添加失败（$p）：请手动在高级安全性里放行入站 TCP $p"
  }
}
if ($fwOpened.Count -gt 0) {
  Ok "已在 Windows 防火墙放行：$($fwOpened -join ', ')"
} else {
  Ok "本机防火墙无需改动（未启用，或对应端口已放行）"
}

# ---------------------------------------------------------------- 回报
Say ""
Say "回报 DoulorCloud…"
$payload = @{
  ip = $Ip; frpsPort = $FrpsPort; panelPort = $PanelPort
  frpsToken = $frpsToken; agentSecret = $agentSecret; token = $Token
} | ConvertTo-Json -Compress

$code = 0; $respText = ""
try {
  $resp = Invoke-WebRequest -Uri "$ApiBase/api/frp/donate/register" -Method Post `
    -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) `
    -UseBasicParsing -TimeoutSec 25
  $code = [int]$resp.StatusCode; $respText = $resp.Content
} catch {
  if ($_.Exception.Response) {
    $code = [int]$_.Exception.Response.StatusCode
    try { $respText = (New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch { }
  }
}

if ($code -ne 200) {
  Warn "回报失败（HTTP $code）"
  if ($respText) { Say $respText }
  Say ""
  Say "节点本机已经跑起来了，但没有登记成功。把下面这段发给管理员："
  Say "  IP=$Ip  frps端口=$FrpsPort  面板端口=$PanelPort"
  Say "  （完整凭据在 $InstallDir\credentials.txt）"
  exit 1
}


# ---------------------------------------------------------------- 装 agent
#
# 为什么需要 agent（而不是让 DoulorCloud 主动推）：
#   实测 Cloudflare Workers 的出站 fetch 打到「裸 IP + 任意端口」会被
#   Cloudflare 接管（返回的是站点本身），所以**推不过去**。改成节点自己拉。
#
# 密钥是**这个节点专属**的（登记响应里的 agentKey）—— 不是全局密钥。
# 用全局密钥的话，任何捐献者都能拉取别的节点的期望状态（里面有别人的 frp 令牌）。
Say ""
# ---------------------------------------------------------------- 用户隧道端口段
#
# 🔴 这一段才是用户**真正连的口**。
#    frps 的 bindPort 只是「客户端接入」，而用户隧道的 remote_port
#    是在**这台服务器上真实绑定**的 —— 这段不开，捐献节点等于没用：
#    用户登得上 frps、面板里也有账号，就是连不到自己的服务。
#
#    段从登记响应里取（就是管理面板里可改的那两个值），取不到用 10000-11000。
$tunMin = 10000
$tunMax = 11000
# openPortMin/Max 是**服务器要放行的**段（比套餐段宽），由管理面板控制。
# 取不到就退回套餐段，再取不到用 10000-11000。
try {
  if ($reg -and $reg.openPortMin) { $tunMin = [int]$reg.openPortMin }
  elseif ($reg -and $reg.plan -and $reg.plan.portMin) { $tunMin = [int]$reg.plan.portMin }
  if ($reg -and $reg.openPortMax) { $tunMax = [int]$reg.openPortMax }
  elseif ($reg -and $reg.plan -and $reg.plan.portMax) { $tunMax = [int]$reg.plan.portMax }
} catch { }
if ($tunMax -lt $tunMin) { $tunMax = $tunMin }

Say ""
Say "放行用户隧道端口段 $tunMin-$tunMax…"
$tunRule = "Doulor frp tunnel $tunMin-$tunMax"
try {
  if (-not (Get-NetFirewallRule -DisplayName $tunRule -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $tunRule -Direction Inbound -Protocol TCP `
      -LocalPort "$tunMin-$tunMax" -Action Allow -Profile Any -ErrorAction Stop | Out-Null
    Ok "已在 Windows 防火墙放行隧道端口段：$tunMin-$tunMax"
  } else {
    Ok "隧道端口段已在放行列表里：$tunMin-$tunMax"
  }
} catch {
  Warn "隧道端口段放行失败：请手动在高级安全性里放行入站 TCP $tunMin-$tunMax"
}

Say "安装节点 agent…"

$agentPath = Join-Path $InstallDir "frp-agent.py"
try {
  Invoke-WebRequest -Uri "$CdnBase/install/frp-agent.py" -OutFile $agentPath -UseBasicParsing -TimeoutSec 90
} catch {
  Die "下载 agent 失败：$CdnBase/install/frp-agent.py"
}

try { $reg = $respText | ConvertFrom-Json } catch { $reg = $null }
if (-not $reg -or -not $reg.nodeIdForAgent -or -not $reg.agentKey) {
  Warn "登记响应里缺少 agent 配置，agent 未安装。"
  Warn "请把下面这段发给管理员：$respText"
} else {
  $agentCfg = @{
    cloud_base       = $ApiBase
    node_id          = $reg.nodeIdForAgent
    panel_base       = "http://127.0.0.1:$PanelPort"
    user_prefix      = "DC_"
    agent_secret     = $reg.agentKey
    interval_seconds = 20
    dry_run          = $false
    timeout_seconds  = 20
    log_file         = (Join-Path $InstallDir "agent.log")
    state_file       = (Join-Path $InstallDir "agent-state.json")
  } | ConvertTo-Json
  $agentCfgPath = Join-Path $InstallDir "agent-config.json"
  Set-Content -Path $agentCfgPath -Value $agentCfg -Encoding UTF8
  # 凭据文件收紧权限（只留 SYSTEM / Administrators / 当前用户）
  try {
    icacls $agentCfgPath /inheritance:r /grant:r "SYSTEM:(R)" "Administrators:(R)" | Out-Null
  } catch { }

  Register-ScheduledTask -TaskName "DoulorFrpAgent" `
    -Action (New-ScheduledTaskAction -Execute $pyExe `
      -Argument "-u `"$agentPath`" --config `"$agentCfgPath`"" -WorkingDirectory $InstallDir) `
    -Trigger (New-ScheduledTaskTrigger -AtStartup) `
    -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)) -Force | Out-Null
  Start-ScheduledTask -TaskName "DoulorFrpAgent"
  Start-Sleep -Seconds 8

  $agentLog = Join-Path $InstallDir "agent.log"
  if (Test-Path $agentLog) {
    $logTail = Get-Content $agentLog -Tail 20 -ErrorAction SilentlyContinue
    if ($logTail -match '无变更|已处理|回报成功') {
      Ok "agent 与 DoulorCloud 通信正常"
    } else {
      Ok "agent 已启动"
      Warn "还没打出同步记录（可能要等下一轮，20 秒后再看 $agentLog）"
    }
  } else {
    Ok "agent 已启动"
  }
}

# ---------------------------------------------------------------- 安全组提醒
Say ""
Say "─────────────────────────────────────────"
Say "  还需要你在云控制台确认「安全组 / 防火墙」放行这两个端口："
Say ""
Say "    TCP $FrpsPort   ← frps 接入（客户端连这个，必须开）"
Say "    TCP $tunMin-$tunMax   ← 用户隧道端口段（最常被漏掉的一个：不开就连不到自己的服务）"
Say "    TCP $PanelPort   ← 面板管理地址（建议只允许你自己的 IP）"
Say ""
Say "  阿里云 / 腾讯云 / 华为云：控制台 → 安全组 → 入方向 → 添加规则"
Say "  AWS / GCP：安全组 / 防火墙规则 → 入站"
Say "─────────────────────────────────────────"
Say ""

Say ""
Write-Host "========== 捐献成功 ==========" -ForegroundColor Green
Say "  节点地址   $Ip"
Say "  frps 端口  $FrpsPort"
Say "  面板端口  $PanelPort"
Say "  面板账号  admin"
Say "  面板口令  $panelPw"
Say ""
Say "  已自动为你上架默认套餐（30 天 / 100 积分 / 端口 10000-10010）"
Say "  你可以随时登录面板改端口区间、改口令、看谁在用。"
Say ""
Say "  凭据也存了一份： $InstallDir\credentials.txt"
Say "  卸载： Unregister-ScheduledTask DoulorFrps,DoulorFrpPanel,DoulorFrpAgent -Confirm:`$false; Remove-Item '$InstallDir' -Recurse -Force"
Say ""
exit 0
