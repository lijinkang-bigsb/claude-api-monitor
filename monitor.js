const http = require('node:http'); // 导入 HTTP 模块，接收本地 Claude Code 请求。

const https = require('node:https'); // 导入 HTTPS 模块，安全转发到上游 API。

const fs = require('node:fs'); // 导入文件模块，读取本地配置。

const path = require('node:path'); // 导入路径模块，定位配置文件。

const os = require('node:os'); // 导入操作系统模块，定位当前 Windows 用户的 Claude Code 设置文件。

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

  return '#' + String(item.id).padStart(3, '0') + ' | ' + item.model + ' | ' + status + ' | ' + time + ' | ' + tokens; // 返回用户所需状态格式。

} // 结束状态行函数。



function render() { // 原地刷新常驻终端面板。

  const running = [...active.values()].sort((a, b) => a.id - b.id).map(one); // 生成进行中的请求行。

  const done = recent.slice(0, 5).map(one); // 生成最近五条已完成请求行。

  const lines = ['Claude Code API 状态小监视器  |  本地转发中  |  Ctrl+C 退出', '监听：' + monitorBaseUrl + '  →  当前上游：' + base, '路由状态：' + routingStatus, '─'.repeat(88), '进行中（' + running.length + '）', ...(running.length ? running : ['暂无请求']), '─'.repeat(88), '最近完成（最新在前）', ...(done.length ? done : ['暂无记录'])]; // 组装整块面板内容。

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

    const item = { id: serial++, model: model(body), started: Date.now(), ended: null, status: null, input: null, output: null, tail: '' }; // 创建不含正文的显示状态。

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

keepClaudeCodeRoutedThroughMonitor(); // 启动时立刻把上方 Claude Code 界面接入监视器。

const routingClock = setInterval(keepClaudeCodeRoutedThroughMonitor, 1000); // 每秒检查一次，兼容 CCswitch 切换 API 后重写设置文件。

routingClock.unref(); // 不让路由检查计时器单独阻止退出。

server.listen(port, '127.0.0.1', render); // 仅绑定本机，局域网无法访问。



function close() { // 定义 Ctrl+C 的优雅关闭流程。

  clearInterval(clock); // 停止刷新面板。

  clearInterval(routingClock); // 停止自动维护 Claude Code 路由的检查。

  restoreClaudeCodeDirectConnection(); // 退出前恢复 Claude Code 直连，关闭监视器后仍可正常使用。

  server.close(() => process.exit(0)); // 关闭端口后退出进程。

  setTimeout(() => process.exit(0), 500).unref(); // 关闭无连接时使用兜底退出。

} // 结束关闭函数。

process.on('SIGINT', close); // 响应 PowerShell 的 Ctrl+C。

process.on('SIGTERM', close); // 响应 VS Code 关闭终端。
