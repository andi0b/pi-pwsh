import { spawn } from "node:child_process";
import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, createBashToolDefinition, formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const UTF8_OUTPUT_PREFIX = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;\n";
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

function extractPwshUserBashCommand(command: string): string | null {
	const trimmed = command.trimStart();
	for (const prefix of ["pwsh", "p"]) {
		if (trimmed === prefix) return "";
		if (trimmed.startsWith(`${prefix} `)) return trimmed.slice(prefix.length).trimStart();
	}
	return null;
}

function createPwshUserBashOperations(pwshOperations: BashOperations): BashOperations {
	return {
		exec: (command, execCwd, options) => {
			const rawCommand = extractPwshUserBashCommand(command);
			options.onData(Buffer.from("[pwsh]\n", "utf-8"));
			return pwshOperations.exec(rawCommand ?? command, execCwd, options);
		},
	};
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	const pwshOperations = createPwshOperations();
	const pwshUserBashOperations = createPwshUserBashOperations(pwshOperations);
	const baseBashTool = createBashToolDefinition(cwd, { operations: pwshOperations });

	pi.on("user_bash", (event) => {
		if (extractPwshUserBashCommand(event.command) === null) {
			return;
		}
		return { operations: pwshUserBashOperations };
	});

	pi.registerTool({
		...baseBashTool,
		name: "pwsh",
		label: "pwsh",
		description: `Execute a PowerShell (pwsh) command in the current working directory. Prefer using the bash tool by default; use this pwsh tool only when PowerShell is better suited for the task. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: "Execute PowerShell commands when PowerShell is a better fit than bash.",
		promptGuidelines: [
			"Use pwsh tool only for PowerShell-specific tasks or when the user explicitly asks for PowerShell; prefer the bash tool by default",
			"If a bash command fails, do not retry it with pwsh just to see whether it works there. Use PowerShell only when it is genuinely a better fit for the task.",
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
