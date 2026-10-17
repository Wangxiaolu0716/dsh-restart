<#
  由 dsh-restart 插件通过 WMI（Win32_Process.Create）启动。

  为什么必须是 WMI：DSH 桌面版把插件宿主（Host）关在自己的 job object 里，
  从 Host 里普通 spawn 出来的进程会一起被带走；WMI 创建的进程父链是
  WmiPrvSE.exe → svchost.exe → services.exe，完全脱离该 job，且仍在
  explorer 的交互会话里，所以能拉起带界面的新实例。

  职责：结束旧实例 → 等它真正消失 → 释放残留端口 → 拉起新实例。
#>
param(
	[Parameter(Mandatory = $true)][int]$OldPid,
	[Parameter(Mandatory = $true)][string]$Exe,
	[int]$Port = 19387,
	[int]$TimeoutSeconds = 45
)

$ErrorActionPreference = 'SilentlyContinue'

$home_ = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$logDir = Join-Path $home_ 'logs'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logPath = Join-Path $logDir 'dsh-restart-plugin.log'

function Write-Log([string]$Message) {
	try {
		$line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Message
		Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
	} catch {}
}

Write-Log "armed: oldPid=$OldPid port=$Port exe=$Exe"

# 1) 结束旧实例整棵树。桌面版没有任何能被插件触发的优雅退出入口
#    （生产版菜单里没有"重启应用与 Host"，托盘只有打开/退出，
#    渲染进程也没有 quit/restart API），所以这里直接终止。
#    Host 会因 IPC 断开自行走 shutdown 流程，端口随之释放。
if (Get-Process -Id $OldPid -ErrorAction SilentlyContinue) {
	& taskkill.exe /PID $OldPid /T /F > $null 2>&1
	Write-Log "taskkill /PID $OldPid /T /F -> exit=$LASTEXITCODE"
} else {
	Write-Log "old pid $OldPid already gone"
}

# 2) 等旧进程消失。
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
	if (-not (Get-Process -Id $OldPid -ErrorAction SilentlyContinue)) { break }
	Start-Sleep -Milliseconds 200
}
$alive = [bool](Get-Process -Id $OldPid -ErrorAction SilentlyContinue)

# 3) 兜底：端口还被占着就清掉占用者（正常情况下 Host 已随旧实例退出）。
$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
	$owner = $listener.OwningProcess
	if ($owner -and $owner -ne 0) {
		Write-Log "port $Port still held by pid $owner -> terminating"
		& taskkill.exe /PID $owner /T /F > $null 2>&1
	}
}
if ($listeners.Count -gt 0) { Start-Sleep -Milliseconds 800 }

# 4) 拉起新实例，命令行与用户双击图标完全一致（主进程不接受任何参数）。
Start-Process -FilePath $Exe -WorkingDirectory (Split-Path -LiteralPath $Exe)
$launchedAt = Get-Date
Write-Log "launched: $Exe (old alive=$alive)"

# 5) 事后确认：等 Host 重新监听端口（Host 起来才会监听），只写日志、不重试。
#    端口在听 = 重启真的成功了，这比数进程名可靠（runner 子进程也带同样的进程名）。
$listening = $false
$verifyDeadline = $launchedAt.AddSeconds(30)
while ((Get-Date) -lt $verifyDeadline) {
	if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { $listening = $true; break }
	Start-Sleep -Milliseconds 500
}
Write-Log ("verify: port {0} listening={1} after {2}s" -f $Port, $listening, [int]((Get-Date) - $launchedAt).TotalSeconds)
