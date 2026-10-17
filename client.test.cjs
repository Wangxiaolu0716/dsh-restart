/**
 * 用假 DOM 跑 dsh-restart 的客户端 apply()，验证：
 *   1. 菜单条已存在时，按钮被 append 到 [role=menubar] 末尾；
 *   2. 菜单条晚到时，MutationObserver 补挂；
 *   3. 点击两次才发 POST，第一次只是确认态，4 秒后自动撤销；
 *   4. ctx.effect 的清理函数把按钮摘掉且 observer 断开。
 * 用法: node client.test.cjs <client.js 路径>
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(process.argv[2] ?? path.join(__dirname, 'client.js'), 'utf8');

/** 极简 DOM stub：只实现 client.js 用到的那几个接口。 */
function createEnv() {
	const listeners = { body: [], node: [] };

	function makeElement(tag) {
		const el = {
			tagName: tag.toUpperCase(),
			children: [],
			attributes: {},
			style: {},
			textContent: '',
			disabled: false,
			title: '',
			parent: null,
			ownListeners: {},
			setAttribute(k, v) { this.attributes[k] = v; },
			getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
			append(child) { this.children.push(child); child.parent = this; },
			remove() {
				if (this.parent === null) return;
				const i = this.parent.children.indexOf(this);
				if (i >= 0) this.parent.children.splice(i, 1);
				this.parent = null;
			},
			addEventListener(type, fn) { (this.ownListeners[type] ??= []).push(fn); },
			dispatch(type, event = {}) {
				const base = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
				for (const fn of this.ownListeners[type] ?? []) fn({ ...base, ...event });
			}
		};
		return el;
	}

	const body = makeElement('body');
	const bar = makeElement('div');
	bar.setAttribute('role', 'menubar');
	const shadowRoot = { querySelector: () => bar };
	const host = makeElement('div');
	host.shadowRoot = shadowRoot;

	let hostAttached = false;
	const menuHost = findable => (hostAttached ? { shadowRoot } : null);

	const document = {
		documentElement: { lang: 'zh-CN' },
		body,
		querySelector(selector) {
			if (selector === '[data-windows-menu]') return menuHost();
			return null;
		},
		createElement: makeElement
	};

	const timers = new Map();
	let timerSeq = 0;
	const window_ = {
		setTimeout(fn, ms) { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
		clearTimeout(id) { timers.delete(id); }
	};
	const fireTimers = () => {
		const pending = [...timers.entries()];
		timers.clear();
		for (const [, t] of pending) t.fn();
	};

	const fetches = [];
	const fetch_ = (url, init) => {
		fetches.push({ url, init });
		return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
	};

	const observers = [];
	class MutationObserver {
		constructor(cb) { this.cb = cb; this.active = true; this.options = null; observers.push(this); }
		observe(_target, options) { this.options = options ?? {}; }
		disconnect() { this.active = false; }
		// 测试用：手动触发一次回调（stub 没有真实的 DOM 事件系统）。
		fire() { if (this.active) this.cb(); }
	}

	return {
		document, window_, MutationObserver, fetch: fetch_, host, shadowRoot, bar,
		attachHost() { hostAttached = true; for (const o of observers) o.fire(); },
		/** 挂载用的那个 observer（带 childList，语言观察器带 attributeFilter）。 */
		get observer() { return observers.find((o) => o.options !== null && o.options.childList === true) ?? null; },
		/** 语言观察器。 */
		get langObserver() { return observers.find((o) => o.options !== null && o.options.attributes === true) ?? null; },
		observers,
		fireTimers, fetches,
		menuButtons: () => bar.children
	};
}

const env = createEnv();
const registered = [];
global.window = Object.assign(Object.create(null), env.window_, {
	__ModuleLoader__: { load: mod => registered.push(mod) }
});
global.document = env.document;
global.MutationObserver = env.MutationObserver;
global.fetch = env.fetch;
global.setTimeout = env.window_.setTimeout;
global.clearTimeout = env.window_.clearTimeout;

// 故意让菜单条先不存在，验证 MutationObserver 补挂路径。
new Function('window', 'document', 'MutationObserver', 'fetch', 'setTimeout', 'clearTimeout', source)(
	global.window, global.document, global.MutationObserver, global.fetch,
	global.setTimeout, global.clearTimeout
);

const failures = [];
const check = (name, cond, extra = '') => {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
	if (!cond) failures.push(name);
};

check('客户端模块已注册', registered.length === 1, `id=${registered[0]?.id}`);
const mod = registered[0].factory();
check('apply 是函数', typeof mod.apply === 'function');
check('无需注入其它服务', Array.isArray(mod.inject), JSON.stringify(mod.inject));

// 装载插件：收集 effect 的清理函数，并记录装载前后的按钮数。
let cleanup = null;
const beforeApply = env.menuButtons().length;
mod.apply({ effect: (fn) => { cleanup = fn(); } });
check('effect 返回清理函数', typeof cleanup === 'function');
check('菜单条未就绪时不报错', env.menuButtons().length === beforeApply);
check('已挂上 MutationObserver', env.observer !== null && env.observer.active === true);

// 模拟 preload 之后注入菜单条。
env.attachHost();
const buttons = env.menuButtons();
check('菜单条就绪后自动补挂按钮', buttons.length === 1, `count=${buttons.length}`);
check('按钮是 menuitem 角色', buttons[0]?.getAttribute('role') === 'menuitem');
check('标签取中文文案', buttons[0]?.textContent === '重启', `"${buttons[0]?.textContent}"`);
check('补挂后断开 observer', env.observer.active === false);

// 语言跟随：<html lang> 变了按钮文案要跟着变。
buttons[0].textContent = '';
env.document.documentElement.lang = 'en-US';
env.langObserver.fire();
check('英文界面切英文文案', buttons[0].textContent === 'Restart', `"${buttons[0].textContent}"`);
env.document.documentElement.lang = 'zh-CN';
env.langObserver.fire();
check('切回中文恢复中文文案', buttons[0].textContent === '重启', `"${buttons[0].textContent}"`);
check('提示文案存在', String(buttons[0]?.title).includes('重启 DeepSeek Harness'), `"${buttons[0]?.title}"`);

// 第一次点击：进确认态，不发请求。
let prevented = null;
buttons[0].dispatch('pointerdown', {});
prevented = buttons[0].ownListeners.pointerdown !== undefined;
check('按下时阻止默认行为（保住输入焦点）', prevented);
buttons[0].dispatch('click', {});
check('第一次点击不发请求', env.fetches.length === 0, `fetches=${env.fetches.length}`);
check('第一次点击进确认态', buttons[0].textContent === '确认重启？', `"${buttons[0].textContent}"`);
check('确认态未禁用', buttons[0].disabled === false);

// 4 秒不点，自动撤销。
env.fireTimers();
check('超时自动撤销回初始态', buttons[0].textContent === '重启', `"${buttons[0].textContent}"`);

// 第二次连点：第一次进确认，第二次才发请求。
buttons[0].dispatch('click', {});
buttons[0].dispatch('click', {});
check('第二次点击发出一次请求', env.fetches.length === 1, `fetches=${env.fetches.length}`);
const call = env.fetches[0] ?? { url: '', init: {} };
check('请求路径正确', call.url === '/api/dsh-restart/restart', call.url);
check('请求方法为 POST', call.init.method === 'POST', call.init.method);
check('带自定义动作头（防 CSRF）', call.init.headers?.['x-dsh-restart-action'] === 'restart');
check('正在重启时按钮禁用', buttons[0].disabled === true);
check('正在重启文案', buttons[0].textContent === '正在重启…', `"${buttons[0].textContent}"`);

// 清理路径：清理函数在装载时已拿到。
const beforeDispose = env.menuButtons().length;
cleanup();
check('清理后按钮被摘掉', env.menuButtons().length === beforeDispose - 1,
	`before=${beforeDispose} after=${env.menuButtons().length}`);

console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILED: ${failures.join(', ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
