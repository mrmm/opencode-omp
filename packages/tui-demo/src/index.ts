/**
 * Hello-world exercise of every OpenCode TUI plugin capability.
 *
 * Purpose is visual verification: each capability is a separate command so it
 * can be triggered and screenshotted in isolation, rather than one blob where a
 * single failure hides the rest.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ A module exports EITHER server() OR tui(), never both. The loader is      │
 * │ explicit about it:                                                        │
 * │   "Plugin ... must default export either server() or tui(), not both"     │
 * │ To ship both, register two separate modules.                              │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Everything here is written as plain function calls. `api.ui.*` components are
 * invoked directly rather than through JSX, so this compiles and runs without
 * @opentui or a JSX runtime. Only the slot demos need real JSX, and they are
 * guarded so their absence cannot take down the rest.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const TRACE = join(homedir(), ".local", "state", "opencode-tui-demo", "trace.log");

/** Written to disk as well as shown on screen: a toast that never renders is invisible. */
function trace(msg: string): void {
	try {
		mkdirSync(dirname(TRACE), { recursive: true });
		appendFileSync(TRACE, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		/* tracing must never break the demo */
	}
}

trace("MODULE_IMPORTED");

type Api = Record<string, any>;

interface Demo {
	id: string;
	title: string;
	description: string;
	run: (api: Api) => void | Promise<void>;
}

/** Each demo is isolated so one failure cannot hide the others. */
function safe(api: Api, label: string, fn: () => unknown): void {
	try {
		fn();
		trace(`OK ${label}`);
	} catch (e) {
		trace(`FAIL ${label} :: ${String(e).slice(0, 200)}`);
		try {
			api.ui?.toast?.({ variant: "error", title: label, message: String(e).slice(0, 120) });
		} catch {
			/* even the error path can fail if ui is absent */
		}
	}
}

const demos: Demo[] = [
	// ── 1. toasts ───────────────────────────────────────────────────────────
	{
		id: "demo.toast.all",
		title: "1 · Toasts — all four variants",
		description: "info, success, warning, error",
		run: (api) => {
			const variants = ["info", "success", "warning", "error"] as const;
			variants.forEach((variant, i) => {
				setTimeout(() => {
					safe(api, `toast:${variant}`, () =>
						api.ui.toast({
							variant,
							title: `${variant} toast`,
							message: `This is a ${variant} notification from the demo plugin.`,
							duration: 6000,
						}),
					);
				}, i * 700);
			});
		},
	},

	// ── 2. alert ────────────────────────────────────────────────────────────
	{
		id: "demo.dialog.alert",
		title: "2 · DialogAlert",
		description: "single-button acknowledgement",
		run: (api) =>
			safe(api, "DialogAlert", () =>
				api.ui.dialog.replace(() =>
					api.ui.DialogAlert({
						title: "Hello from a plugin",
						message:
							"DialogAlert renders a titled message with one confirm action.\n\n" +
							"Rendered entirely by the host — the plugin only supplied text.",
						onConfirm: () => trace("alert confirmed"),
					}),
				),
			),
	},

	// ── 3. confirm ──────────────────────────────────────────────────────────
	{
		id: "demo.dialog.confirm",
		title: "3 · DialogConfirm",
		description: "two-way choice, result surfaced as a toast",
		run: (api) =>
			safe(api, "DialogConfirm", () =>
				api.ui.dialog.replace(() =>
					api.ui.DialogConfirm({
						title: "Confirm something",
						message: "Choosing either option closes the dialog and raises a toast.",
						onConfirm: () => {
							trace("confirm: yes");
							api.ui.toast({ variant: "success", message: "You confirmed" });
						},
						onCancel: () => {
							trace("confirm: no");
							api.ui.toast({ variant: "warning", message: "You cancelled" });
						},
					}),
				),
			),
	},

	// ── 4. prompt ───────────────────────────────────────────────────────────
	{
		id: "demo.dialog.prompt",
		title: "4 · DialogPrompt",
		description: "free-text input, echoed back",
		run: (api) =>
			safe(api, "DialogPrompt", () =>
				api.ui.dialog.replace(() =>
					api.ui.DialogPrompt({
						title: "Type something",
						placeholder: "anything at all…",
						onConfirm: (value: string) => {
							trace(`prompt: ${value}`);
							api.ui.toast({ variant: "info", title: "You typed", message: value || "(empty)" });
						},
						onCancel: () => trace("prompt cancelled"),
					}),
				),
			),
	},

	// ── 5. select ───────────────────────────────────────────────────────────
	{
		id: "demo.dialog.select",
		title: "5 · DialogSelect",
		description: "filterable list with categories and descriptions",
		run: (api) =>
			safe(api, "DialogSelect", () =>
				api.ui.dialog.replace(() =>
					api.ui.DialogSelect({
						title: "Pick one",
						placeholder: "type to filter…",
						options: [
							{ title: "Alpha", value: "a", description: "first option", category: "Letters" },
							{ title: "Beta", value: "b", description: "second option", category: "Letters" },
							{ title: "One", value: "1", description: "a number", category: "Numbers" },
							{ title: "Two", value: "2", description: "another number", category: "Numbers" },
							{ title: "Disabled", value: "x", description: "cannot be chosen", disabled: true },
						],
						onSelect: (opt: { title: string; value: unknown }) => {
							trace(`select: ${opt.value}`);
							api.ui.toast({ variant: "success", title: "Selected", message: opt.title });
						},
					}),
				),
			),
	},

	// ── 6. dialog stack ─────────────────────────────────────────────────────
	{
		id: "demo.dialog.stack",
		title: "6 · Dialog stack — replace and resize",
		description: "swap content in place, then grow the dialog",
		run: (api) =>
			safe(api, "dialog.stack", () => {
				api.ui.dialog.setSize("medium");
				api.ui.dialog.replace(() =>
					api.ui.DialogAlert({
						title: "Step 1 of 2 (medium)",
						message: "This dialog will replace itself and resize in two seconds.",
					}),
				);
				setTimeout(() => {
					api.ui.dialog.setSize("xlarge");
					api.ui.dialog.replace(() =>
						api.ui.DialogAlert({
							title: "Step 2 of 2 (xlarge)",
							message:
								`Replaced in place. depth=${api.ui.dialog.depth} open=${api.ui.dialog.open} ` +
								`size=${api.ui.dialog.size}`,
						}),
					);
				}, 2000);
			}),
	},

	// ── 7. theme ────────────────────────────────────────────────────────────
	{
		id: "demo.theme",
		title: "7 · Theme palette",
		description: "read the active theme's colour tokens",
		run: (api) =>
			safe(api, "theme", () => {
				const t = api.theme.current;
				const rgba = (c: any) =>
					c && typeof c === "object"
						? `rgb(${Math.round((c.r ?? 0) * 255)},${Math.round((c.g ?? 0) * 255)},${Math.round((c.b ?? 0) * 255)})`
						: String(c);
				const lines = [
					`selected : ${api.theme.selected}`,
					`mode     : ${api.theme.mode?.()}`,
					`ready    : ${api.theme.ready}`,
					"",
					`primary  : ${rgba(t.primary)}`,
					`accent   : ${rgba(t.accent)}`,
					`success  : ${rgba(t.success)}`,
					`warning  : ${rgba(t.warning)}`,
					`error    : ${rgba(t.error)}`,
					`text     : ${rgba(t.text)}`,
					`bgPanel  : ${rgba(t.backgroundPanel)}`,
				].join("\n");
				trace(`theme:\n${lines}`);
				api.ui.dialog.replace(() =>
					api.ui.DialogAlert({ title: "Active theme", message: lines }),
				);
			}),
	},

	// ── 8. kv ───────────────────────────────────────────────────────────────
	{
		id: "demo.kv",
		title: "8 · KV store — persists across restarts",
		description: "increments a counter each time it runs",
		run: (api) =>
			safe(api, "kv", () => {
				const n = (Number(api.kv.get("demo.counter", 0)) || 0) + 1;
				api.kv.set("demo.counter", n);
				trace(`kv counter=${n}`);
				api.ui.toast({
					variant: "info",
					title: "KV store",
					message: `Run count: ${n} (survives restart; ready=${api.kv.ready})`,
					duration: 6000,
				});
			}),
	},

	// ── 9. state ────────────────────────────────────────────────────────────
	{
		id: "demo.state",
		title: "9 · Host state — sessions, LSP, MCP, paths",
		description: "read-only view of what the TUI knows",
		run: (api) =>
			safe(api, "state", () => {
				const s = api.state;
				const lsp = s.lsp?.() ?? [];
				const mcp = s.mcp?.() ?? [];
				const lines = [
					`ready     : ${s.ready}`,
					`sessions  : ${s.session?.count?.()}`,
					`worktree  : ${s.path?.worktree}`,
					`directory : ${s.path?.directory}`,
					`branch    : ${s.vcs?.branch ?? "(none)"}`,
					`providers : ${(s.provider ?? []).length}`,
					"",
					`LSP (${lsp.length}): ${lsp.map((l: any) => `${l.id}=${l.status}`).join(", ") || "none"}`,
					`MCP (${mcp.length}): ${mcp.map((m: any) => `${m.name}=${m.status}`).join(", ") || "none"}`,
				].join("\n");
				trace(`state:\n${lines}`);
				api.ui.dialog.replace(() => api.ui.DialogAlert({ title: "Host state", message: lines }));
			}),
	},

	// ── 10. attention ───────────────────────────────────────────────────────
	{
		id: "demo.attention",
		title: "10 · Attention — desktop notification + sound",
		description: "OS-level notification with a sound pack entry",
		run: (api) =>
			safe(api, "attention", async () => {
				const res = await api.attention.notify({
					title: "OpenCode TUI demo",
					message: "Desktop notification from a plugin",
					notification: true,
					sound: { name: "done", when: "always" },
				});
				trace(`attention: ${JSON.stringify(res)}`);
				api.ui.toast({
					variant: res?.ok ? "success" : "warning",
					title: "attention.notify",
					message: JSON.stringify(res),
					duration: 7000,
				});
			}),
	},

	// ── 11. plugin registry ─────────────────────────────────────────────────
	{
		id: "demo.plugins",
		title: "11 · Plugin registry",
		description: "what the TUI thinks is installed",
		run: (api) =>
			safe(api, "plugins", () => {
				const list = api.plugins?.list?.() ?? [];
				const body =
					list
						.map(
							(p: any) =>
								`${p.active ? "●" : "○"} ${p.id}  ${p.source}  ${p.enabled ? "enabled" : "disabled"}`,
						)
						.join("\n") || "(none reported)";
				trace(`plugins:\n${body}`);
				api.ui.dialog.replace(() =>
					api.ui.DialogAlert({ title: `Plugins (${list.length})`, message: body }),
				);
			}),
	},

	// ── 12. events ──────────────────────────────────────────────────────────
	{
		id: "demo.events",
		title: "12 · Event bus — live subscription",
		description: "toasts on the next few host events",
		run: (api) =>
			safe(api, "events", () => {
				let seen = 0;
				const types = ["message.updated", "session.updated", "message.part.updated"];
				const offs = types.map((t) =>
					api.event.on(t, () => {
						if (seen++ >= 3) return;
						trace(`event: ${t}`);
						api.ui.toast({ variant: "info", title: "event", message: t, duration: 3000 });
					}),
				);
				api.ui.toast({
					variant: "success",
					title: "Subscribed",
					message: `Listening to ${types.length} event types; will report the first few.`,
				});
				// Bounded: never leave listeners attached indefinitely.
				setTimeout(() => offs.forEach((o: any) => o?.()), 60_000);
			}),
	},

	// ── 13. slots (needs JSX) ───────────────────────────────────────────────
	{
		id: "demo.slots",
		title: "13 · Slots — render into host regions",
		description: "requires a JSX runtime; reports what it finds",
		run: (api) =>
			safe(api, "slots", () => {
				const names = [
					"app", "app_bottom", "home_logo", "home_prompt", "home_prompt_right",
					"home_bottom", "home_footer", "session_prompt", "session_prompt_right",
					"sidebar_title", "sidebar_content", "sidebar_footer",
				];
				const hasRegister = typeof api.slots?.register === "function";
				trace(`slots: register=${hasRegister}`);
				api.ui.dialog.replace(() =>
					api.ui.DialogAlert({
						title: "Slots",
						message:
							`api.slots.register available: ${hasRegister}\n\n` +
							`Host slots:\n${names.map((n) => `  • ${n}`).join("\n")}\n\n` +
							`Rendering into these needs a JSX runtime (@opentui/solid), which this\n` +
							`demo deliberately avoids so the other twelve demos run without it.`,
					}),
				);
			}),
	},

	// ── 14. route ───────────────────────────────────────────────────────────
	{
		id: "demo.route",
		title: "14 · Routes — current route info",
		description: "custom screens also need JSX",
		run: (api) =>
			safe(api, "route", () => {
				const cur = api.route?.current;
				trace(`route: ${JSON.stringify(cur)}`);
				api.ui.dialog.replace(() =>
					api.ui.DialogAlert({
						title: "Routing",
						message:
							`current: ${JSON.stringify(cur, null, 2)}\n\n` +
							`api.route.register([{ name, render }]) adds screens, reachable via\n` +
							`api.route.navigate(name, params). render() must return JSX.`,
					}),
				);
			}),
	},
];

const tui = async (api: Api) => {
	trace(`TUI_CALLED version=${api?.app?.version ?? "?"}`);
	trace(`SURFACE ${Object.keys(api ?? {}).sort().join(",")}`);

	// Register every demo as a command, plus a menu that lists them.
	const commands = demos.map((d) => ({
		title: d.title,
		value: d.id,
		description: d.description,
		category: "TUI Demo",
		slash: { name: d.id.replace(/\./g, "-") },
		onSelect: () => void d.run(api),
	}));

	const menu = {
		title: "0 · Demo menu — every capability",
		value: "demo.menu",
		description: "pick a capability to exercise",
		category: "TUI Demo",
		slash: { name: "demo" },
		onSelect: () =>
			safe(api, "menu", () =>
				api.ui.dialog.replace(() =>
					api.ui.DialogSelect({
						title: "OpenCode TUI capability demo",
						placeholder: "filter…",
						options: demos.map((d) => ({
							title: d.title,
							value: d.id,
							description: d.description,
							onSelect: () => void d.run(api),
						})),
					}),
				),
			),
	};

	// Modern keymap API, with the deprecated command API as a fallback so this
	// still registers on hosts that have not migrated.
	let registered = false;
	if (typeof api.keymap?.registerLayer === "function") {
		safe(api, "keymap.registerLayer", () => {
			api.keymap.registerLayer({ commands: [menu, ...commands] });
			registered = true;
		});
	}
	if (!registered && typeof api.command?.register === "function") {
		safe(api, "command.register(legacy)", () => {
			api.command.register(() => [menu, ...commands]);
			registered = true;
		});
	}
	trace(`commands registered=${registered} count=${commands.length + 1}`);

	// Announce on load so there is immediate visual proof, without needing any
	// command to be found first.
	setTimeout(() => {
		safe(api, "boot toast", () =>
			api.ui.toast({
				variant: "success",
				title: "TUI demo loaded",
				message: registered
					? `${demos.length} demos registered — open the command palette and search "demo"`
					: `${demos.length} demos ready, but no command API was available`,
				duration: 10_000,
			}),
		);
	}, 1200);

	api.lifecycle?.onDispose?.(() => trace("DISPOSED"));
};

export default { id: "tui-demo", tui };
