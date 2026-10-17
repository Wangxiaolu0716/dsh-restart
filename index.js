/**
 * dsh-restart — 宿主端。
 *
 * 桌面版没有任何能被插件触发的重启入口：生产版的应用菜单里没有
 * "重启应用与 Host"（那条目只在 development 为真时出现），托盘菜单只有
 * 打开/退出，渲染进程也没有 quit/restart API，配置管理器只会提示用户手动重启。
 * 所以这里自己开一条路：暴露一个仅回环可达的 POST 路由，收到请求后用一个
 * 脱离 DSH job object 的 WMI 进程去结束旧实例并拉起新实例。
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-restart';
export const inject = ['webServer'];

/** 重启端点。放在 `/api` 前缀下，与其它插件的路由家族一致。 */
export const RESTART_PATH = '/api/dsh-restart/restart';
const ACTION_HEADER = 'x-dsh-restart-action';
const ACTION_VALUE = 'restart';
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'restart.ps1');

/** 写一个 JSON 响应。 */
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(payload)
	});
	res.end(payload);
}

/**
 * 回环判据，以对端 socket 地址为准（Host 头是调用方可控的，只作附加检查）。
 * IPv4-mapped IPv6（`::ffff:127.0.0.1`）按 IPv4 归一化。
 */
function isLoopbackAddress(address) {
	if (typeof address !== 'string') return false;
	const value = address.toLowerCase();
	if (value === '::1') return true;
	const ipv4 = value.startsWith('::ffff:') ? value.slice(7) : value;
	const octets = ipv4.split('.');
	return octets.length === 4 && octets[0] === '127'
		&& octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** 解析 Host 头，兼容带方括号与不带方括号的 IPv6 字面量。 */
function hostNameOf(value) {
	if (typeof value !== 'string') return null;
	const host = value.trim().toLowerCase();
	if (host.startsWith('[')) {
		const close = host.indexOf(']');
		if (close <= 1) return null;
		const suffix = host.slice(close + 1);
		if (suffix !== '' && !/^:\d+$/.test(suffix)) return null;
		return host.slice(1, close);
	}
	const firstColon = host.indexOf(':');
	const lastColon = host.lastIndexOf(':');
	if (firstColon !== lastColon) return host;
	if (lastColon === -1) return host.replace(/\.$/, '');
	if (!/^\d+$/.test(host.slice(lastColon + 1))) return null;
	return host.slice(0, lastColon).replace(/\.$/, '');
}

function isLoopbackHostHeader(req) {
	const hostname = hostNameOf(req.headers.host);
	return hostname === 'localhost' || isLoopbackAddress(hostname);
}

/**
 * 放行前先挡掉非本机调用方与非 POST。自定义动作头让请求变成非简单请求，
 * 外部页面无法在不触发 CORS 预检的情况下构造它，从而挡住 CSRF。
 */
function rejectForeign(req, res) {
	if (req.method !== 'POST') {
		sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
		return true;
	}
	const peer = req.socket?.remoteAddress;
	if (!isLoopbackAddress(peer) || !isLoopbackHostHeader(req)) {
		sendJson(res, 403, { ok: false, error: 'forbidden' });
		return true;
	}
	const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].toLowerCase() : '';
	if (!contentType.startsWith('application/json') || req.headers[ACTION_HEADER] !== ACTION_VALUE) {
		sendJson(res, 403, { ok: false, error: 'forbidden-action' });
		return true;
	}
	return false;
}

/**
 * 通过 WMI 启动重启脚本。
 *
 * 脚本必须以 WMI 创建而非本进程 spawn：Host 与 Electron 同处一个 job object，
 * 普通子进程会随旧实例一起被杀。WMI 创建的进程父链是 WmiPrvSE.exe，不受影响。
 *
 * 整条命令再交给 `conhost.exe --headless`：本机默认终端是 Windows Terminal，
 * 它会忽略 powershell 的 -WindowStyle Hidden，脚本于是跑在一个可见控制台里；
 * 新实例又继承那个控制台，窗口被日志一直占着不会消失，关掉还会连带杀掉新
 * 实例。conhost 的无头模式不给脚本分配任何窗口，这条继承链就此断开。
 *
 * 内层命令用 -EncodedCommand 传递，绕开多层引号转义。
 *
 * @param oldPid - 要结束的 Electron 主进程 pid（Host 的父进程）。
 * @param exe - 该进程的可执行文件路径，新实例以它启动。
 * @param port - Host 正在监听的端口，供脚本等待新实例就绪与清理残留。
 */
function armRestart(oldPid, exe, port) {
	const commandLine = 'conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden'
		+ ` -File "${SCRIPT_PATH}" -OldPid ${oldPid} -Exe "${exe}" -Port ${port}`;
	const inner = 'Invoke-CimMethod -ClassName Win32_Process -MethodName Create'
		+ ` -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}' }`;
	const encoded = Buffer.from(inner, 'utf16le').toString('base64');
	execFile(
		'powershell.exe',
		['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
		{ windowsHide: true, timeout: 20_000 },
		(error, stdout, stderr) => {
			if (error) console.error('[dsh-restart] WMI arm failed:', error.message, String(stderr ?? '').trim());
			else console.info('[dsh-restart] WMI arm ok:', String(stdout ?? '').trim());
		}
	);
}

/**
 * 处理一次重启请求：先回响应（让浏览器看到结果），再安排真正的重启。
 * 300ms 足够响应落到客户端；随后旧实例被终止，连接断开是预期现象。
 */
function handleRestart(req, res) {
	if (rejectForeign(req, res)) return;

	const oldPid = process.ppid;
	const exe = process.execPath;
	// 监听端口就是这次连接的本端端口：配置为 0 时它是 OS 分配的，硬编码会错。
	const port = req.socket?.localPort;
	if (typeof oldPid !== 'number' || oldPid <= 0 || typeof exe !== 'string' || exe === '') {
		sendJson(res, 500, { ok: false, error: 'cannot-resolve-desktop-process' });
		return;
	}
	if (typeof port !== 'number' || port <= 0) {
		sendJson(res, 500, { ok: false, error: 'cannot-resolve-port' });
		return;
	}

	console.info(`[dsh-restart] restart requested: oldPid=${oldPid} exe=${exe} port=${port}`);
	sendJson(res, 200, { ok: true, oldPid, exe, port });
	setTimeout(() => { armRestart(oldPid, exe, port); }, 300);
}

/**
 * 注册重启路由。
 * @param ctx - 携带 webServer 服务的插件上下文。
 */
export function apply(ctx) {
	ctx.effect(
		() => ctx.webServer.register({ kind: 'exact', path: RESTART_PATH, handler: handleRestart }),
		'dsh-restart: restart route'
	);
}
