Set-Location -LiteralPath $PSScriptRoot # 切换到项目目录，确保 Node.js 找得到所需文件。

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'config.json'))) { # 检查是否已经完成初始化。

    Write-Host '请先运行：powershell -ExecutionPolicy Bypass -File .\setup.ps1' -ForegroundColor Yellow # 输出可复制的初始化命令。

    exit 1 # 以失败状态退出，防止误启动。

} # 结束初始化检查。

node (Join-Path $PSScriptRoot 'monitor.js') # 启动会常驻在此终端的 Node.js 监视器。
