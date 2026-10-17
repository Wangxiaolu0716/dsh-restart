/**
 * dsh-restart — 浏览器端。
 *
 * 手写 `__ModuleLoader__` bundle（无需构建）。按钮装在 Windows 标题栏菜单条
 * 的末尾，就是 preload 造出「应用 / 编辑」的那一行：它是 open shadow root，
 * 而按钮的样式规则（高度、内边距、hover 背景）在那个 shadow root 的 <style>
 * 里用的是裸 `button` 选择器，所以插进去的元素自动与它们外观一致。
 *
 * 桌面版没有任何能被插件触发的重启入口（生产版菜单里没有"重启应用与 Host"，
 * 托盘只有打开/退出，渲染进程也没有 quit/restart API），所以按钮点击后调用
 * 宿主端自己的 /api/dsh-restart/restart 路由，由宿主安排重启。
 *
 * 一次点击先进确认态：重启会终止正在运行的任务，而这个按钮又常驻标题栏，
 * 位置太顺手，所以第二次点击才真正触发；4 秒不点自动撤销。
 */
window.__ModuleLoader__.load({
	id: "dsh-restart",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var RESTART_PATH = "/api/dsh-restart/restart";
		/** preload 给菜单条宿主打的标记；open shadow root，所以能直接注入。 */
		var HOST_SELECTOR = "[data-windows-menu]";
		/** 确认态自动撤销的时限，避免按钮长期停在"确认"上。 */
		var CONFIRM_TIMEOUT_MS = 4000;

		var zh = {
			action: "重启",
			confirm: "确认重启？",
			restarting: "正在重启…",
			title: "重启 DeepSeek Harness，让新装的插件生效"
		};
		var en = {
			action: "Restart",
			confirm: "Confirm restart?",
			restarting: "Restarting…",
			title: "Restart DeepSeek Harness so newly installed plugins take effect"
		};

		/** 跟随界面语言，判据与 preload 的 resolveDesktopLocale 一致。 */
		function text(key) {
			var lang = String(document.documentElement.lang || "").toLowerCase();
			return (lang.indexOf("zh") === 0 ? zh : en)[key];
		}

		/** 调用宿主端重启路由。自定义请求头让外部页面无法免预检构造这个请求。 */
		function requestRestart() {
			return fetch(RESTART_PATH, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-dsh-restart-action": "restart"
				},
				body: "{}"
			}).then((response) => response.json());
		}

		/** 菜单条节点；preload 还没挂上时返回 null。 */
		function findMenuBar() {
			var host = document.querySelector(HOST_SELECTOR);
			var shadow = host === null ? null : host.shadowRoot;
			return shadow === null ? null : shadow.querySelector("[role=menubar]");
		}

		/** 造一个重启按钮，含状态机；外观完全由菜单条的 shadow 样式表提供。 */
		function createButton() {
			var button = document.createElement("button");
			button.type = "button";
			button.setAttribute("role", "menuitem");
			// 与同级按钮一致：按下时不要把焦点从正在编辑的输入框里挪走。
			button.addEventListener("pointerdown", (event) => { event.preventDefault(); });

			var phase = "idle";
			var timer = 0;

			var render = () => {
				button.textContent = phase === "restarting" ? text("restarting")
					: phase === "confirm" ? text("confirm")
						: text("action");
				button.disabled = phase === "restarting";
				button.style.opacity = phase === "restarting" ? "0.5" : "";
				button.title = phase === "idle" ? text("title") : "";
			};

			var setPhase = (next) => {
				phase = next;
				window.clearTimeout(timer);
				if (phase === "confirm") {
					timer = window.setTimeout(() => { setPhase("idle"); }, CONFIRM_TIMEOUT_MS);
				}
				render();
			};

			button.addEventListener("click", () => {
				if (phase === "idle") {
					setPhase("confirm");
					return;
				}
				if (phase !== "confirm") return;
				setPhase("restarting");
				requestRestart().then((payload) => {
					if (payload !== null && typeof payload === "object" && payload.ok === true) return;
					setPhase("idle");
				}).catch(() => {
					// 旧实例被结束、连接断开，这正是重启的过程，不是错误；
					// 万一没重启起来，页面刷新即可恢复按钮。
				});
			});

			// 界面语言由 preload 写在 <html lang> 上，跟着它重渲染。
			var langObserver = new MutationObserver(render);
			langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });

			render();
			return {
				element: button,
				dispose: () => {
					window.clearTimeout(timer);
					langObserver.disconnect();
					button.remove();
				}
			};
		}

		/**
		 * 把按钮装到标题栏菜单条末尾。
		 * @param ctx - 客户端插件上下文。
		 */
		function apply(ctx) {
			ctx.effect(
				() => {
					var mounted = null;
					var observer = null;

					var mount = () => {
						if (mounted !== null) return true;
						var bar = findMenuBar();
						if (bar === null) return false;
						mounted = createButton();
						bar.append(mounted.element);
						return true;
					};

					if (!mount()) {
						// 菜单条由 preload 在页面挂载后注入，可能比插件后到。
						// 观察 documentElement 而非 body：插件 apply 得早时 body 还不存在。
						observer = new MutationObserver(() => {
							if (mount() && observer !== null) observer.disconnect();
						});
						observer.observe(document.documentElement, { childList: true, subtree: true });
					}

					return () => {
						if (observer !== null) observer.disconnect();
						if (mounted !== null) mounted.dispose();
					};
				},
				"dsh-restart: titlebar button"
			);
		}

		exports.apply = apply;
		exports.inject = [];

		return module.exports;
	}
});
