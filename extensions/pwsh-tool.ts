import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, createBashTool, formatSize, keyHint, truncateTail } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";

const OUTPUT_SAFETY_MARGIN_BYTES = 1024;
const PWSH_PREVIEW_LINES = 5;
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

function getTempFilePath() {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pi-pwsh-${id}.log`);
}

function buildTruncationNotice(truncation: ReturnType<typeof truncateTail>, fullOutputPath: string) {
	const startLine = truncation.totalLines - truncation.outputLines + 1;
	const endLine = truncation.totalLines;
	if (truncation.lastLinePartial) {
		return `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine}. Full output: ${fullOutputPath}]`;
	}
	if (truncation.truncatedBy === "lines") {
		return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
	}
	return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
}

function maybePostTruncateText(text: string) {
	const bytes = Buffer.byteLength(text, "utf-8");
	const lines = text.split("\n").length;
	const shouldPostTruncate = bytes > DEFAULT_MAX_BYTES - OUTPUT_SAFETY_MARGIN_BYTES || lines > DEFAULT_MAX_LINES;

	if (!shouldPostTruncate) {
		return null;
	}

	const truncation = truncateTail(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: Math.max(1024, DEFAULT_MAX_BYTES - OUTPUT_SAFETY_MARGIN_BYTES),
	});

	if (!truncation.truncated) {
		return null;
	}

	const fullOutputPath = getTempFilePath();
	try {
		writeFileSync(fullOutputPath, text, "utf-8");
	} catch {
		// Ignore temp file write failures; still return truncated output
	}

	const notice = buildTruncationNotice(truncation, fullOutputPath);
	return {
		text: `${truncation.content}\n\n${notice}`,
		details: {
			truncation,
			fullOutputPath,
		},
	};
}

function sanitizeBinaryOutput(text: string): string {
	return Array.from(text)
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
			if (code <= 0x1f) return false;
			if (code >= 0xfff9 && code <= 0xfffb) return false;
			return true;
		})
		.join("");
}

function getTextOutput(result: {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}): string {
	return (result.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => sanitizeBinaryOutput(stripAnsi(c.text ?? "")).replace(/\r/g, ""))
		.join("\n");
}

function renderPwshResult(result: { content: Array<{ type: string; text?: string }>; details?: any }, expanded: boolean, theme: any) {
	const output = getTextOutput(result).trim();
	if (!output) {
		return new Text("", 0, 0);
	}

	const lines = output.split("\n");
	let body = output;
	if (!expanded && lines.length > PWSH_PREVIEW_LINES) {
		const skipped = lines.length - PWSH_PREVIEW_LINES;
		body =
			`${theme.fg("muted", `... (${skipped} earlier lines,`)} ${keyHint("app.tools.expand", "to expand")})` +
			`\n${lines.slice(-PWSH_PREVIEW_LINES).join("\n")}`;
	}

	return new Text(theme.fg("toolOutput", body), 0, 0);
}

function prefixPowershellScriptWithUtf8(command: string): string {
	const trimmed = command.trimStart();
	return trimmed.startsWith(UTF8_OUTPUT_PREFIX) ? command : `${UTF8_OUTPUT_PREFIX}${command}`;
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
	const baseBashTool = createBashTool(cwd, { operations: pwshOperations });

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
		renderCall(args, theme) {
			const command = typeof args?.command === "string" ? args.command : null;
			const timeout = typeof args?.timeout === "number" ? args.timeout : undefined;
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
			const commandDisplay =
				command === null ? theme.fg("error", "[invalid arg]") : command ? command : theme.fg("toolOutput", "...");
			return new Text(theme.fg("toolTitle", theme.bold(`pwsh> ${commandDisplay}`)) + timeoutSuffix, 0, 0);
		},
		renderResult(result, options, theme) {
			return renderPwshResult(result as any, options.expanded, theme);
		},
		execute: async (id, params, signal, onUpdate, _ctx) => {
			try {
				const result = await baseBashTool.execute(id, params, signal, onUpdate);
				if ((result.details as any)?.truncation) {
					return result;
				}

				const text = getTextOutput(result as any);
				const post = maybePostTruncateText(text);
				if (!post) return result;

				return {
					content: [{ type: "text", text: post.text }],
					details: {
						...(result.details ?? {}),
						...post.details,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const post = maybePostTruncateText(message);
				if (!post) throw error;
				throw new Error(post.text);
			}
		},
	});
}
