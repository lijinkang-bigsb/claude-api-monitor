const fs = require('node:fs'); // 导入文件系统模块，用于安全恢复 Claude Code 设置。

const path = require('node:path'); // 导入路径模块，仅用于定位临时诊断日志。

const os = require('node:os'); // 导入操作系统模块，用于自行定位当前用户的 Claude Code 设置。

const monitorPid = Number(process.argv[2]); // 读取需要监视的主监视器进程号。

const monitorBaseUrl = process.argv[3]; // 读取监视器占用的本地 API 地址。

const scheduledTaskName = process.argv[4]; // 读取 Windows 为本次恢复创建的一次性任务名。

const settingsPath = path.join(os.homedir(), '.claude', 'settings.json'); // 自行定位 Claude Code 用户设置，缩短计划任务命令。

const configPath = path.join(__dirname, 'config.json'); // 自行定位守护程序同目录的个人配置文件。

if (!Number.isInteger(monitorPid) || monitorPid <= 0 || !monitorBaseUrl || !scheduledTaskName) process.exit(1); // 参数不完整时退出，避免修改未知文件。

function isMonitorAlive() { // 判断主监视器进程是否仍然存在。

  try { // Windows 上使用零信号只检查进程，不会终止它。

    process.kill(monitorPid, 0); // 查询对应进程号是否可访问。

    return true; // 查询成功说明监视器仍在运行。

  } catch { // 进程不存在或已经被垃圾桶强制终止时进入这里。

    return false; // 告诉轮询逻辑需要执行恢复。

  } // 结束进程状态检查保护。

} // 结束监视器存活检查函数。

function restoreDirectConnection() { // 把 Claude Code 从失效的 3456 恢复到最后一个真实 API。

  try { // 捕获文件被其他程序短暂占用或写入一半的情况。

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // 读取 Claude Code 当前设置且不输出其中的认证信息。

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')); // 读取监视器记住的最后一个真实上游。

    const upstreamBaseUrl = String(config.upstreamBaseUrl || '').replace(/\/$/, ''); // 清理真实上游末尾的斜杠。

    if (!settings.env || typeof settings.env !== 'object') return true; // 没有环境变量对象时无需恢复。

    if (settings.env.ANTHROPIC_BASE_URL !== monitorBaseUrl) return true; // CCswitch 已写入新地址时绝不覆盖它。

    if (!upstreamBaseUrl || upstreamBaseUrl === monitorBaseUrl) return false; // 上游无效或形成自循环时等待下次检查。

    settings.env.ANTHROPIC_BASE_URL = upstreamBaseUrl; // 仅把 API 地址恢复为真实上游，保留 token、模型和其他配置。

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8'); // 将恢复后的有效 JSON 写回 Claude Code 设置。

    return true; // 告诉轮询逻辑恢复已经完成。

  } catch { // 文件处于临时写入状态时不破坏它。

    return false; // 稍后重试恢复，最多等待十五秒。

  } // 结束恢复过程保护。

} // 结束直连恢复函数。

function isRoutedThroughMonitor() { // 判断 Claude Code 是否已经完成本次 3456 路由接管。

  try { // 设置文件可能正由 CCswitch 或监视器短暂写入。

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); // 读取当前 API 地址而不输出其他字段。

    return settings.env && settings.env.ANTHROPIC_BASE_URL === monitorBaseUrl; // 只有亲眼看到 3456 才认为恢复器已经武装。

  } catch { // 文件暂时不可读时保持未武装状态。

    return false; // 等待下一轮检查。

  } // 结束路由状态读取保护。

} // 结束路由接管判断函数。

function removeScheduledTask() { // 恢复结束后注销本次 Windows 临时任务。

  if (!scheduledTaskName || process.platform !== 'win32') return; // 非 Windows 或直接测试运行时无需清理任务。

  try { // 清理失败也不能阻止守护程序退出。

    require('node:child_process').spawnSync('schtasks.exe', ['/Delete', '/TN', scheduledTaskName, '/F'], { windowsHide: true, stdio: 'ignore' }); // 删除任务定义，不触碰任何用户文件。

  } catch { // Windows 正在更新任务状态时可能短暂拒绝删除。

  } // 结束临时任务清理保护。

} // 结束计划任务清理函数。

let missingChecks = 0; // 记录连续检测不到主监视器的次数，防止启动瞬间误判。

let restoreAttempts = 0; // 记录恢复尝试次数，避免异常情况下永久驻留。

let startupChecks = 0; // 记录等待监视器写入 3456 的次数。

let armed = false; // 记录恢复器是否已经亲眼看到本次路由接管。

const guardianTimer = setInterval(() => { // 每半秒检查一次主监视器状态。

  if (!armed) { // 未看到 3456 以前不允许提前判定“无需恢复”。

    startupChecks += 1; // 记录一次接管等待。

    if (isRoutedThroughMonitor()) { // 监视器已把 Claude Code 接到 3456。

      armed = true; // 正式武装强杀恢复逻辑。

      missingChecks = 0; // 从干净状态开始检查主进程。

      return; // 下一轮再判断监视器是否存活。

    } // 结束路由接管观察。

    if (startupChecks >= 30) { // 十五秒仍未接管说明监视器安全降级或启动失败。

      clearInterval(guardianTimer); // 停止无意义等待。

      removeScheduledTask(); // 注销本次未用上的临时任务。

      process.exit(0); // 不修改原本的直连设置并退出。

    } // 结束接管等待超时处理。

    return; // 未武装时继续等待，不检查父进程死亡。

  } // 结束未武装分支。

  if (isMonitorAlive()) { // 主监视器仍在工作时只重置计数。

    missingChecks = 0; // 清除偶发检查失败记录。

    return; // 等待下一轮检查。

  } // 结束主监视器存活分支。

  missingChecks += 1; // 记录一次连续丢失。

  if (missingChecks < 2) return; // 连续两次丢失后才恢复，避免短暂系统调度波动。

  restoreAttempts += 1; // 记录本次文件恢复尝试。

  if (restoreDirectConnection() || restoreAttempts >= 30) { // 恢复成功或重试十五秒后结束守护程序。

    clearInterval(guardianTimer); // 停止状态轮询。

    removeScheduledTask(); // 注销 Windows 中仅用于本次运行的临时恢复任务。

    process.exit(0); // 安静退出，不留下后台常驻进程。

  } // 结束恢复完成判断。

}, 500); // 将检查间隔设置为五百毫秒。
