import { spawn } from "node:child_process";
import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, createBashToolDefinition, formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const UTF8_OUTPUT_PREFIX = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;\n";
const PWSH_EDITOR_FACTORY_MARK = Symbol.for("pi-pwsh.editorFactory");

function killProcessTree(pid: number) {
	try {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			process.kill(pid, "SIGTERM");
		}
	} catch {
		// Ignore kill errors (process may have already exited)
	}
}

function prefixPowershellScriptWithUtf8(command: string): string {
	const trimmed = command.trimStart();
	return trimmed.startsWith(UTF8_OUTPUT_PREFIX) ? command : `${UTF8_OUTPUT_PREFIX}${command}`;
}

// Copied from pi's bash tool formatBashCall() and modified only to render `pwsh>` instead of `$`.
function formatPwshCall(args: { command?: string; timeout?: number } | undefined, theme: any): string {
	const command = typeof args?.command === "string" ? args.command : null;
	const timeout = args?.timeout;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? theme.fg("error", "[invalid arg]") : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`pwsh> ${commandDisplay}`)) + timeoutSuffix;
}

function createPwshOperations(): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) =>
			new Promise((resolve, reject) => {
				const child = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", prefixPowershellScriptWithUtf8(command)], {
					cwd,
					env,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				const timer =
					timeout && timeout > 0
						? setTimeout(() => {
								timedOut = true;
								if (child.pid) killProcessTree(child.pid);
						  }, timeout * 1000)
						: undefined;

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				const onAbort = () => {
					if (child.pid) killProcessTree(child.pid);
				};

				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}

				child.on("error", (err: NodeJS.ErrnoException) => {
					if (timer) clearTimeout(timer);
					if (signal) signal.removeEventListener("abort", onAbort);
					if (err.code === "ENOENT") {
						reject(new Error("pwsh executable not found. Install PowerShell 7 and ensure 'pwsh' is on PATH."));
						return;
					}
					reject(err);
				});

				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					if (signal) signal.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	const pwshOperations = createPwshOperations();
	const pwshBangCommandPrefix = "pwsh> ";
	function extractPwshBangCommand(command: string): string {
		const marker = /(?:^|\n)\s*pwsh>\s*([\s\S]*)$/m.exec(command);
		if (marker?.[1] !== undefined) {
			return marker[1];
		}
		return command.startsWith(pwshBangCommandPrefix) ? command.slice(pwshBangCommandPrefix.length) : command;
	}

	const pwshBangOperations: BashOperations = {
		exec: (command, execCwd, options) => {
			const rawCommand = extractPwshBangCommand(command);
			return pwshOperations.exec(rawCommand, execCwd, options);
		},
	};
	const baseBashTool = createBashToolDefinition(cwd, { operations: pwshOperations });

	type PendingPwshBang = { command: string; excludeFromContext: boolean; createdAt: number };
	const pendingPwshBangCommands: PendingPwshBang[] = [];
	const PENDING_PWSH_BANG_TTL_MS = 10_000;

	function parsePwshBangInput(text: string): { command: string; excludeFromContext: boolean } | null {
		const trimmed = text.trim();
		if (trimmed.startsWith(">>")) {
			const command = trimmed.slice(2).trim();
			return command ? { command, excludeFromContext: true } : null;
		}
		if (trimmed.startsWith(">")) {
			const command = trimmed.slice(1).trim();
			return command ? { command, excludeFromContext: false } : null;
		}
		return null;
	}

	function prunePendingPwshBangCommands() {
		const cutoff = Date.now() - PENDING_PWSH_BANG_TTL_MS;
		for (let i = pendingPwshBangCommands.length - 1; i >= 0; i--) {
			if (pendingPwshBangCommands[i].createdAt < cutoff) {
				pendingPwshBangCommands.splice(i, 1);
			}
		}
	}

	function queuePwshBangCommand(command: string, excludeFromContext: boolean) {
		prunePendingPwshBangCommands();
		pendingPwshBangCommands.push({ command, excludeFromContext, createdAt: Date.now() });
	}

	function consumePendingPwshBangCommand(command: string, excludeFromContext: boolean) {
		prunePendingPwshBangCommands();
		const index = pendingPwshBangCommands.findIndex(
			(entry) => entry.command === command && entry.excludeFromContext === excludeFromContext,
		);
		if (index < 0) {
			return false;
		}
		pendingPwshBangCommands.splice(index, 1);
		return true;
	}

	class PwshPrefixEditor extends CustomEditor {
		constructor(tui: any, theme: any, private readonly appKeybindings: any) {
			super(tui, theme, appKeybindings);
		}

		handleInput(data: string): void {
			if (this.appKeybindings.matches(data, "tui.input.submit")) {
				const parsed = parsePwshBangInput(this.getText());
				if (parsed) {
					const displayCommand = `${pwshBangCommandPrefix}${parsed.command}`;
					queuePwshBangCommand(displayCommand, parsed.excludeFromContext);
					this.setText(`${parsed.excludeFromContext ? "!!" : "!"} ${displayCommand}`);
				}
			}
			super.handleInput(data);
		}
	}

	type EditorFactory = (tui: any, theme: any, keybindings: any) => any;
	type EditorUI = {
		setEditorComponent: (factory: EditorFactory | undefined) => void;
		getEditorComponent?: () => EditorFactory | undefined;
	};

	function createPwshEditorFactory(previousFactory?: EditorFactory): EditorFactory {
		const factory: EditorFactory = (tui, theme, keybindings) => {
			if (!previousFactory) {
				return new PwshPrefixEditor(tui, theme, keybindings);
			}

			const editor = previousFactory(tui, theme, keybindings);
			const originalHandleInput = editor?.handleInput?.bind(editor);
			if (
				typeof originalHandleInput !== "function" ||
				typeof editor?.getText !== "function" ||
				typeof editor?.setText !== "function"
			) {
				return editor;
			}

			editor.handleInput = (data: string) => {
				if (keybindings.matches(data, "tui.input.submit")) {
					const parsed = parsePwshBangInput(editor.getText());
					if (parsed) {
						const displayCommand = `${pwshBangCommandPrefix}${parsed.command}`;
						queuePwshBangCommand(displayCommand, parsed.excludeFromContext);
						editor.setText(`${parsed.excludeFromContext ? "!!" : "!"} ${displayCommand}`);
					}
				}
				originalHandleInput(data);
			};

			return editor;
		};
		Object.defineProperty(factory, PWSH_EDITOR_FACTORY_MARK, { value: true });
		return factory;
	}

	function installPwshPrefixEditor(ctx: { hasUI: boolean; ui: EditorUI }) {
		if (!ctx.hasUI) {
			return;
		}

		const previousFactory = ctx.ui.getEditorComponent?.();
		if ((previousFactory as any)?.[PWSH_EDITOR_FACTORY_MARK]) {
			return;
		}

		ctx.ui.setEditorComponent(createPwshEditorFactory(previousFactory));
	}

	pi.on("resources_discover", (_event, ctx) => {
		installPwshPrefixEditor(ctx as any);
	});

	pi.on("session_start", (_event, ctx) => {
		installPwshPrefixEditor(ctx as any);
	});

	pi.on("user_bash", (event) => {
		if (!consumePendingPwshBangCommand(event.command, event.excludeFromContext)) {
			return;
		}
		return { operations: pwshBangOperations };
	});

	pi.registerTool({
		...baseBashTool,
		name: "pwsh",
		label: "pwsh",
		description: `Execute a PowerShell (pwsh) command in the current working directory. Prefer using the bash tool by default; use this pwsh tool only when PowerShell is better suited for the task. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: "Execute PowerShell commands when PowerShell is a better fit than bash.",
		promptGuidelines: [
			"Prefer using the bash tool by default; use this tool only for PowerShell-specific tasks or when the user explicitly asks for PowerShell.",
			"If a bash command fails, do not retry it in PowerShell just to see whether it works there. Use PowerShell only when it is genuinely a better fit for the task.",
		],
		renderCall(args, theme, context) {
			// Copied from pi's bash tool renderCall(); keeps duration state for the reused bash renderResult().
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatPwshCall(args, theme));
			return text;
		},
	});
}
