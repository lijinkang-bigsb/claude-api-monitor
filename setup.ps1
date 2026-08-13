$projectRoot = $PSScriptRoot # 获取本脚本所在的项目目录。

$examplePath = Join-Path $projectRoot 'config.example.json' # 计算示例配置文件路径。

$configPath = Join-Path $projectRoot 'config.json' # 计算用户实际配置文件路径。

if (-not (Test-Path -LiteralPath $configPath)) { # 只在首次初始化时创建用户配置。

    Copy-Item -LiteralPath $examplePath -Destination $configPath # 从无密钥的示例复制配置文件。

    Write-Host '已创建 config.json，请把 upstreamBaseUrl 改为你原来 CCswitch 使用的 API 地址。' -ForegroundColor Yellow # 提醒用户修改上游地址。

} # 结束首次初始化判断。

Write-Host '初始化完成。修改 config.json 后，运行 start-monitor.ps1，并另开一个终端运行 claude。' -ForegroundColor Green # 告知后续使用步骤。
