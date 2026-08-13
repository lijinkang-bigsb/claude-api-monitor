const http = require('node:http'); // 导入 HTTP 模块，接收本地 Claude Code 请求。

const https = require('node:https'); // 导入 HTTPS 模块，安全转发到上游 API。

const fs = require('node:fs'); // 导入文件模块，读取本地配置。

const path = require('node:path'); // 导入路径模块，定位配置文件。

const os = require('node:os'); // 导入操作系统模块，定位当前 Windows 用户的 Claude Code 设置文件。

const childProcess = require('node:child_process'); // 导入子进程模块，启动独立的断线恢复守护进程。

const readline = require('node:readline'); // 导入终端光标控制模块，兼容 VS Code 的分栏任务终端。



const file = path.join(__dirname, 'config.json'); // 计算配置文件的固定路径。

if (!fs.existsSync(file)) { // 在用户尚未初始化时终止启动。

  console.error('未找到 config.json，请先运行 setup.ps1。'); // 输出简短的修复提示。

  process.exit(1); // 返回失败状态。

} // 结束配置文件检查。

const config = JSON.parse(fs.readFileSync(file, 'utf8')); // 读取 JSON 配置。

let base = String(config.upstreamBaseUrl || '').replace(/\/$/, ''); // 清理并保存当前真实上游地址，CCswitch 切换时会自动更新。

const port = Number(config.port || 3456); // 读取本地监听端口。

const monitorBaseUrl = 'http://127.0.0.1:' + port; // 生成 Claude Code 应连接的本机监视器地址。

if (!config.display || typeof config.display !== 'object') config.display = {}; // 为旧版配置补上显示开关对象。

let displayEnabled = config.display.enabled !== false; // 读取总显示开关，默认显示所有可见请求。

let showDshRequests = config.display.showDsh !== false; // 读取 DSH 显示开关，默认显示 DSH 请求。

const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json'); // 定位 Claude Code 用户级设置文件。

if (!base) { // 拒绝空的上游地址。

  throw new Error('config.json 中的 upstreamBaseUrl 不能为空。'); // 给出精确错误原因。

} // 结束上游地址检查。

let upstream = new URL(base); // 解析上游 API 基础地址，允许在 CCswitch 切换后动态替换。

if (!['http:', 'https:'].includes(upstream.protocol)) { // 只允许 HTTP(S) 连接。

  throw new Error('upstreamBaseUrl 必须以 http:// 或 https:// 开头。'); // 拒绝不安全或错误的协议。

} // 结束协议检查。



const active = new Map(); // 保存进行中的请求。

const recent = []; // 保存最近完成的请求。

let serial = 1; // 创建可读的请求编号。

let previous = ''; // 缓存上次面板，减少闪烁。

let displayedLines = 0; // 记录监视器上次绘制的行数，刷新时只覆盖自己的区域。

let routingStatus = '正在检查 Claude Code 路由…'; // 保存“上方 Claude Code 界面”是否已经接入监视器的状态。

let closing = false; // 防止 Ctrl+C 和终止信号同时触发两次关闭流程。

function saveUpstream(newBaseUrl) { // 记住 CCswitch 新写入的真实 API 地址。

  const cleanedBaseUrl = String(newBaseUrl || '').replace(/\/$/, ''); // 清除末尾斜杠，避免请求路径出现双斜杠。

  const candidate = new URL(cleanedBaseUrl); // 验证 CCswitch 给出的地址是合法 URL。

  if (!['http:', 'https:'].includes(candidate.protocol)) throw new Error('不支持的上游协议'); // 拒绝非 HTTP(S) 地址。

  if (cleanedBaseUrl === monitorBaseUrl) return; // 防止把监视器自身误记成上游并形成死循环。

  base = cleanedBaseUrl; // 更新内存中的真实上游地址。

  upstream = candidate; // 让之后的新请求立即转发到新服务商。

  config.upstreamBaseUrl = cleanedBaseUrl; // 更新配置对象中的持久化字段。

  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8'); // 保存到 config.json，重启监视器后仍使用该服务商。

} // 结束上游保存函数。

function saveDisplayPreferences() { // 持久保存终端快捷键控制的显示开关。

  config.display.enabled = displayEnabled; // 把总显示开关写入配置对象。

  config.display.showDsh = showDshRequests; // 把 DSH 显示开关写入配置对象。

  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8'); // 保存到被 Git 忽略的个人 config.json。

} // 结束显示偏好保存函数。

function identifyClient(headers) { // 根据公开 User-Agent 判断请求来自哪个客户端。

  const userAgent = String(headers['user-agent'] || '').toLowerCase(); // 读取不含密钥的标准客户端标识。

  if (userAgent.startsWith('deepseek-harness/')) return 'DSH'; // DSH 官方代码固定使用 deepseek-harness/版本号。

  if (userAgent.includes('claude-code') || userAgent.includes('claude-cli')) return 'Claude'; // 识别 Claude Code 常见客户端标识。

  return '其他'; // 无稳定标识的兼容客户端归入“其他”。

} // 结束客户端识别函数。

function keepClaudeCodeRoutedThroughMonitor() { // 确保 CCswitch 切换模型后不会让 Claude Code 绕过监视器。

  try { // 捕获文件被 CCswitch 临时占用或正在写入时的情况。

    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8')); // 读取 Claude Code 当前设置而不显示认证密钥。

    if (!settings.env || typeof settings.env !== 'object') settings.env = {}; // 若 env 不存在则创建它，保留其他全部设置。

    if (settings.env.ANTHROPIC_BASE_URL === monitorBaseUrl) { // 地址已经正确时无需写文件。

      routingStatus = 'Claude Code 已通过监视器接入'; // 在终端面板中显示正常状态。

      return; // 结束本次检查。

    } // 结束地址一致性判断。

    saveUpstream(settings.env.ANTHROPIC_BASE_URL); // 先把 CCswitch 新选择的真实 API 地址记为上游，绝不丢失切换结果。

    settings.env.ANTHROPIC_BASE_URL = monitorBaseUrl; // 再把 Claude Code 入口改回监视器，认证 token、模型和其他字段保持原样。

    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8'); // 写回格式化后的有效 JSON 设置文件。

    routingStatus = '已跟随 CCswitch 切换并重新接管路由'; // 告诉用户新上游已经保存且路由已安全接管。

  } catch { // 设置文件暂时不可读时不停止代理服务。

    routingStatus = '等待 Claude Code 设置文件可用'; // 在面板中显示简短状态而不暴露文件内容。

  } // 结束设置文件访问保护。

} // 结束自动路由维护函数。

function restoreClaudeCodeDirectConnection() { // 关闭监视器时恢复 Claude Code 直连，避免下次启动出现本地连接失败。

  try { // 即使设置文件暂时不可用，也要允许监视器正常退出。

    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8')); // 读取当前 Claude Code 用户设置。

    if (!settings.env || typeof settings.env !== 'object') settings.env = {}; // 确保环境变量对象存在。

    if (settings.env.ANTHROPIC_BASE_URL !== monitorBaseUrl) return; // 若 CCswitch 已经写入新地址，则不覆盖它。

    settings.env.ANTHROPIC_BASE_URL = base; // 把 Claude Code 恢复为直连当前真实上游。

    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8'); // 保存恢复后的设置。

  } catch { // 恢复失败时不输出认证信息或阻塞退出。

  } // 结束设置恢复保护。

} // 结束直连恢复函数。

function quoteTaskArgument(value) { // 将路径或参数安全包装成 Windows 任务计划程序命令行片段。

  return '"' + String(value).replace(/"/g, '\\"') + '"'; // 用双引号保护空格并转义参数内部的双引号。

} // 结束任务参数包装函数。

function escapeXml(value) { // 将任务字段转义为安全的 XML 文本。

  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); // 转义 XML 中具有语法含义的三个字符。

} // 结束 XML 转义函数。

function launchRecoveryGuardian() { // 通过 Windows 任务计划程序启动不属于 VS Code 进程树的恢复进程。

  const guardianPath = path.join(__dirname, 'guardian.js'); // 定位与监视器同目录的守护程序。

  const taskName = 'ClaudeApiMonitorGuardian-' + process.pid; // 为本次监视器创建不会与其他实例冲突的一次性任务名。

  const scheduledTime = new Date(Date.now() + 60 * 60 * 1000); // 生成一小时后的备用计划时间，实际会立刻手动运行。

  const startBoundary = scheduledTime.getFullYear() + '-' + String(scheduledTime.getMonth() + 1).padStart(2, '0') + '-' + String(scheduledTime.getDate()).padStart(2, '0') + 'T' + String(scheduledTime.getHours()).padStart(2, '0') + ':' + String(scheduledTime.getMinutes()).padStart(2, '0') + ':00'; // 生成任务 XML 使用的本地时间边界。

  const taskArguments = [guardianPath, String(process.pid), monitorBaseUrl, taskName].map(quoteTaskArgument).join(' '); // 组合不含 Key 或提示词的守护程序参数。

  const taskXmlPath = path.join(os.tmpdir(), taskName + '.xml'); // 在系统临时目录中创建短期任务定义文件。

  const taskXml = '<?xml version="1.0" encoding="UTF-16"?>\n' + // 声明 Windows 任务计划程序接受的 XML 编码。
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n' + // 创建标准任务根节点。
    '  <Triggers><TimeTrigger><StartBoundary>' + escapeXml(startBoundary) + '</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>\n' + // 添加备用的一次性时间触发器。
    '  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n' + // 仅使用当前登录用户的普通权限运行。
    '  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT1H</ExecutionTimeLimit><Enabled>true</Enabled></Settings>\n' + // 设置短期后台任务的运行策略。
    '  <Actions Context="Author"><Exec><Command>' + escapeXml(process.execPath) + '</Command><Arguments>' + escapeXml(taskArguments) + '</Arguments></Exec></Actions>\n' + // 把 Node 可执行文件与参数分开保存，彻底避免空格和长度解析问题。
    '</Task>\n'; // 结束任务 XML。

  fs.writeFileSync(taskXmlPath, Buffer.from('\uFEFF' + taskXml, 'utf16le')); // 以带 BOM 的 UTF-16LE 写入 Windows 任务 XML。

  const createResult = childProcess.spawnSync('schtasks.exe', ['/Create', '/TN', taskName, '/XML', taskXmlPath, '/F'], { windowsHide: true, encoding: 'utf8' }); // 从 XML 向当前 Windows 用户注册一次性恢复任务。

  try { fs.unlinkSync(taskXmlPath); } catch { } // 注册后立即删除临时 XML，不留下路径信息。

  if (createResult.status !== 0) { // 注册失败时不把 Claude Code 接到 3456，避免再次留下坏配置。

    routingStatus = '无法注册强杀恢复保护，未接管 Claude Code'; // 在面板中明确说明请求仍保持直连。

    return false; // 告诉启动流程禁止修改 Claude Code 路由。

  } // 结束任务注册失败处理。

  const runResult = childProcess.spawnSync('schtasks.exe', ['/Run', '/TN', taskName], { windowsHide: true, encoding: 'utf8' }); // 让 Windows 立即启动刚注册的恢复任务。

  if (runResult.status !== 0) { // 任务无法启动时清除注册并保持 Claude Code 直连。

    childProcess.spawnSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { windowsHide: true, stdio: 'ignore' }); // 删除无法运行的临时任务。

    routingStatus = '强杀恢复保护无法启动，未接管 Claude Code'; // 在面板中报告安全降级状态。

    return false; // 禁止把 Claude Code 路由改成 3456。

  } // 结束任务运行失败处理。

  return true; // 告诉启动流程已经具备垃圾桶强杀恢复能力。

} // 结束守护程序启动函数。



function seconds(ms) { // 将毫秒格式化为秒。

  return ms < 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms / 1000) + 's'; // 为短请求保留一位小数。

} // 结束时间格式化函数。



function model(body) { // 从请求 JSON 中读取模型名。

  try { return JSON.parse(body.toString('utf8')).model || '未知模型'; } catch { return '未知模型'; } // 从不记录正文，解析失败时仅显示占位符。

} // 结束模型提取函数。



function usage(item, chunk) { // 从 API 响应中增量提取 token 用量。

  const text = item.tail + chunk.toString('utf8'); // 衔接前一个数据包的结尾。

  const input = [...text.matchAll(/"input_tokens"\s*:\s*(\d+)/g)]; // 查找输入 token 字段。

  const output = [...text.matchAll(/"output_tokens"\s*:\s*(\d+)/g)]; // 查找输出 token 字段。

  if (input.length) item.input = Number(input.at(-1)[1]); // 保存最近一次输入 token 数。

  if (output.length) item.output = Number(output.at(-1)[1]); // 保存最近一次输出 token 数。

  item.tail = text.slice(-200); // 只保留二百字符以跨分包匹配，不存储完整内容。

} // 结束 token 提取函数。



function one(item) { // 将一条状态记录转为终端显示的一行。

  const status = item.status === null ? '请求中' : String(item.status); // 未结束请求显示“请求中”。

  const time = seconds((item.ended || Date.now()) - item.started); // 计算已耗时或总耗时。

  const tokens = item.input === null && item.output === null ? 'token: --' : 'token: ' + (item.input ?? '?') + ' in / ' + (item.output ?? '?') + ' out'; // 组合 token 信息。

  return '#' + String(item.id).padStart(3, '0') + ' | ' + item.client + ' | ' + item.model + ' | ' + status + ' | ' + time + ' | ' + tokens; // 同时显示客户端、模型、状态和 token。

} // 结束状态行函数。



function render() { // 原地刷新常驻终端面板。

  const isVisible = (item) => displayEnabled && (showDshRequests || item.client !== 'DSH'); // 根据总开关和 DSH 开关决定是否显示请求。

  const running = [...active.values()].filter(isVisible).sort((a, b) => a.id - b.id).map(one); // 生成过滤后的进行中请求行。

  const done = recent.filter(isVisible).slice(0, 5).map(one); // 生成过滤后的最近五条已完成请求行。

  const switchText = 'M 总显示：' + (displayEnabled ? '开' : '关') + '  |  D 显示 DSH：' + (showDshRequests ? '开' : '关') + '  |  Ctrl+C 退出'; // 生成可直接操作的快捷键说明。

  const emptyRunningText = displayEnabled ? '暂无请求' : '状态显示已暂停；请求仍在正常转发'; // 总开关关闭时明确说明不会影响请求。

  const lines = ['Claude Code API 状态小监视器  |  本地转发中', switchText, '监听：' + monitorBaseUrl + '  →  当前上游：' + base, '路由状态：' + routingStatus, '─'.repeat(88), '进行中（' + running.length + '）', ...(running.length ? running : [emptyRunningText]), '─'.repeat(88), '最近完成（最新在前）', ...(done.length ? done : ['暂无记录'])]; // 组装整块面板内容。

  const screen = lines.join('\n') + '\n'; // 添加终端需要的换行符。

  if (screen === previous) return; // 内容未变化时不重绘。

  if (displayedLines > 0) readline.moveCursor(process.stdout, 0, -displayedLines); // 从当前位置上移到监视器上次输出的第一行。

  readline.cursorTo(process.stdout, 0); // 把光标移到当前行最左侧，避免文字错位。

  readline.clearScreenDown(process.stdout); // 仅清除监视器自己下方的旧内容，不清空整个任务终端。

  previous = screen; // 记录当前内容。

  process.stdout.write(screen); // 输出完整状态面板，让 VS Code 任务终端稳定显示。

  displayedLines = screen.split('\n').length - 1; // 保存本次输出的逻辑行数供下次刷新。

} // 结束面板函数。



function finish(item, status) { // 统一处理一次请求结束。

  if (item.ended) return; // 防止多个网络事件重复记录。

  item.ended = Date.now(); // 记录结束时刻。

  item.status = status; // 保存 HTTP 状态码。

  active.delete(item.id); // 将请求从进行中移除。

  recent.unshift(item); // 将请求插到历史顶部。

  recent.length = Math.min(recent.length, 50); // 只保存五十条，控制内存。

  render(); // 立即显示最终状态。

} // 结束收尾函数。



const server = http.createServer((client, reply) => { // 创建本机反向代理服务。

  const parts = []; // 暂存请求体以读取模型字段。

  client.on('data', (part) => parts.push(part)); // 收集请求体片段。

  client.on('error', () => reply.destroy()); // 客户端提前断开时销毁响应。

  client.on('end', () => { // 在完整收到请求后连接上游。

    const body = Buffer.concat(parts); // 合并并原样保留请求体。

    const item = { id: serial++, client: identifyClient(client.headers), model: model(body), started: Date.now(), ended: null, status: null, input: null, output: null, tail: '' }; // 创建不含正文、只含公开客户端类型的状态记录。

    active.set(item.id, item); // 登记为进行中的请求。

    render(); // 显示“请求中”。

    const headers = { ...client.headers, host: upstream.host }; // 保留认证头并把 Host 改为上游域名。

    delete headers.connection; // 删除仅适用于本地一跳的连接头。

    const basePath = upstream.pathname.replace(/\/$/, ''); // 读取上游地址中可选的基础路径，例如 /v1。
    const clientPath = client.url.startsWith('/') ? client.url : '/' + client.url; // 确保 Claude Code 原始请求路径以斜杠开头。
    const target = basePath && (clientPath === basePath || clientPath.startsWith(basePath + '/')) ? clientPath : basePath + clientPath; // 若原始请求已有 /v1 则不重复拼接，否则补上上游基础路径。

    const network = upstream.protocol === 'https:' ? https : http; // 按上游协议选择网络实现。

    const remote = network.request({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, method: client.method, path: target, headers: headers }, (response) => { // 发起透明转发请求。

      reply.writeHead(response.statusCode || 502, response.headers); // 原样发送状态码和响应头。

      response.on('data', (part) => { usage(item, part); reply.write(part); }); // 分析 token 后立刻转发流式数据。

      response.on('end', () => { reply.end(); finish(item, response.statusCode || 502); }); // 完成后关闭响应并记录状态。

      response.on('error', () => { reply.destroy(); finish(item, '响应错误'); }); // 响应流中断时显示简短错误。

    }); // 结束上游响应处理。

    remote.on('error', () => { // 处理上游不可连接的错误。

      if (!reply.headersSent) reply.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }); // 在尚未回包时写入标准 502。

      reply.end('{"error":"本地监视器无法连接上游 API"}'); // 不暴露网络细节给 Claude Code。

      finish(item, 502); // 将连接失败显示为 502。

    }); // 结束连接错误处理。

    remote.end(body); // 原样提交 Claude Code 请求体。

  }); // 结束客户端请求完成事件。

}); // 结束服务器创建。



const clock = setInterval(render, 250); // 每 250 毫秒更新进行中请求的耗时。

clock.unref(); // 不让刷新计时器单独阻止退出。

const recoveryProtected = launchRecoveryGuardian(); // 在修改 Claude Code 路由前先部署强杀恢复保护。

if (recoveryProtected) keepClaudeCodeRoutedThroughMonitor(); // 只有 Windows 已接管恢复任务后才把上方 Claude Code 界面接入监视器。

const routingClock = recoveryProtected ? setInterval(keepClaudeCodeRoutedThroughMonitor, 1000) : null; // 只有具备强杀恢复保护时才自动维护 CCswitch 切换后的路由。

if (routingClock) routingClock.unref(); // 存在路由计时器时才解除其进程保持作用。

function handleKeypress(_text, key) { // 处理监视器终端中的单键开关。

  if (!key) return; // 忽略无法识别的终端输入。

  if (key.ctrl && key.name === 'c') { // 在原始输入模式下自行处理 Ctrl+C。

    close(); // 执行完整的直连恢复和退出流程。

    return; // 避免继续处理同一个按键。

  } // 结束 Ctrl+C 判断。

  if (key.name === 'm') displayEnabled = !displayEnabled; // 按 M 暂停或恢复全部状态显示。

  else if (key.name === 'd') showDshRequests = !showDshRequests; // 按 D 单独隐藏或显示 DSH 请求。

  else return; // 其他按键不做任何修改。

  saveDisplayPreferences(); // 保存开关，下次启动仍沿用当前选择。

  previous = ''; // 强制下一帧立即重绘新的开关状态。

  render(); // 立刻反馈按键结果。

} // 结束按键处理函数。

if (process.stdin.isTTY) { // 只有真实交互终端才启用单键控制。

  readline.emitKeypressEvents(process.stdin); // 让 Node.js 把键盘输入解析为按键事件。

  process.stdin.setRawMode(true); // 无需按回车即可响应 M、D 和 Ctrl+C。

  process.stdin.resume(); // 保持终端输入流处于可读状态。

  process.stdin.on('keypress', handleKeypress); // 注册快捷键处理函数。

} // 结束交互终端初始化。

server.listen(port, '127.0.0.1', render); // 仅绑定本机，局域网无法访问。



function close() { // 定义 Ctrl+C 的优雅关闭流程。

  if (closing) return; // 已经进入关闭流程时忽略重复信号。

  closing = true; // 标记监视器正在关闭。

  clearInterval(clock); // 停止刷新面板。

  if (routingClock) clearInterval(routingClock); // 已启用路由维护时才停止对应检查。

  restoreClaudeCodeDirectConnection(); // 退出前恢复 Claude Code 直连，关闭监视器后仍可正常使用。

  if (process.stdin.isTTY) { // 仅在交互终端中恢复输入模式。

    process.stdin.removeListener('keypress', handleKeypress); // 移除快捷键监听，防止退出期间再次触发。

    process.stdin.setRawMode(false); // 恢复 PowerShell 正常的行输入模式。

    process.stdin.pause(); // 停止读取终端输入流。

  } // 结束终端输入恢复。

  server.close(() => process.exit(0)); // 关闭端口后退出进程。

  setTimeout(() => process.exit(0), 500).unref(); // 关闭无连接时使用兜底退出。

} // 结束关闭函数。

process.on('SIGINT', close); // 响应 PowerShell 的 Ctrl+C。

process.on('SIGTERM', close); // 响应 VS Code 关闭终端。
