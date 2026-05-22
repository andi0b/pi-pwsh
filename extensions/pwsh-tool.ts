import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, createBashToolDefinition, formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const UTF8_OUTPUT_PREFIX = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;\n";

interface PwshToolSettings {
	replaceBash: boolean;
	availableCommands: string[];
}

const DEFAULT_SETTINGS: PwshToolSettings = {
	replaceBash: false,
	availableCommands: ["rg", "fd", "jq", "yq", "curl", "sed"],
};

const pwshSchema = Type.Object({
	command: Type.String({ description: "PowerShell (pwsh) command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

function detectAvailablePwshCommands(commands: string[]): string[] {
	return commands.filter((command) => {
		const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Get-Command ${command} -ErrorAction SilentlyContinue`], {
			stdio: "ignore",
		});
		return result.status === 0;
	});
}

function createPwshToolText(settings: PwshToolSettings) {
	const { replaceBash } = settings;
	if (!replaceBash) {
		return {
			description: `Execute a PowerShell (pwsh) command in the current working directory. Prefer using the bash tool by default; use this pwsh tool only when PowerShell is better suited for the task. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
			promptSnippet: "Execute PowerShell commands when PowerShell is a better fit than bash.",
			promptGuidelines: [
				"Use pwsh tool only for PowerShell-specific tasks or when the user explicitly asks for PowerShell; prefer the bash tool by default",
				"If a bash command fails, do not retry it with pwsh just to see whether it works there. Use PowerShell only when it is genuinely a better fit for the task.",
			],
		};
	}

	const availableCommands = detectAvailablePwshCommands(settings.availableCommands);
	return {
		description: `Execute a PowerShell (pwsh) command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: "Execute PowerShell commands (Get-ChildItem, Select-String, Get-Content, etc.)",
		promptGuidelines:
			availableCommands.length > 0
				? [
					`Available pwsh commands include: ${availableCommands.join(", ")}`,
					...(availableCommands.includes("rg")
						? ["Prefer `rg` for text search instead of PowerShell-specific commands such as `Select-String` when appropriate."]
						: []),
					...(availableCommands.includes("fd")
						? ["Prefer `fd` for file discovery instead of PowerShell-specific commands such as `Get-ChildItem` when appropriate."]
						: []),
					"For compound pwsh commands with mixed output types, pipe earlier commands to `Out-Host` to prevent later output from falling back to verbose list formatting; for example: `Get-Location | Out-Host; Get-ChildItem -Force`.",
				]
				: undefined,
	};
}

function readSettingsFile(settingsPath: string): Record<string, unknown> {
	if (!existsSync(settingsPath)) return {};
	try {
		const value = JSON.parse(readFileSync(settingsPath, "utf-8"));
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function readSettings(cwd: string = process.cwd()): Record<string, unknown> {
	const globalSettings = readSettingsFile(join(process.env.HOME ?? homedir(), ".pi", "agent", "settings.json"));
	const projectSettings = readSettingsFile(join(cwd, ".pi", "settings.json"));
	return {
		...globalSettings,
		...projectSettings,
		pwshTool: {
			...(typeof globalSettings.pwshTool === "object" && globalSettings.pwshTool !== null && !Array.isArray(globalSettings.pwshTool)
				? (globalSettings.pwshTool as Record<string, unknown>)
				: {}),
			...(typeof projectSettings.pwshTool === "object" && projectSettings.pwshTool !== null && !Array.isArray(projectSettings.pwshTool)
				? (projectSettings.pwshTool as Record<string, unknown>)
				: {}),
		},
	};
}

function readPwshToolSettings(cwd: string): PwshToolSettings {
	const settings = readSettings(cwd);
	const pwshTool = settings.pwshTool;
	const pwshToolSettings = typeof pwshTool === "object" && pwshTool !== null && !Array.isArray(pwshTool) ? (pwshTool as Record<string, unknown>) : {};
	const replaceBash = pwshToolSettings.replaceBash;
	const availableCommands = pwshToolSettings.availableCommands;
	return {
		replaceBash: typeof replaceBash === "boolean" ? replaceBash : DEFAULT_SETTINGS.replaceBash,
		availableCommands:
			Array.isArray(availableCommands) && availableCommands.every((command) => typeof command === "string")
				? availableCommands
				: DEFAULT_SETTINGS.availableCommands,
	};
}

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

function createPwshUserBashOperations(pwshOperations: BashOperations, options?: { emitMarker?: boolean }): BashOperations {
	return {
		exec: (command, execCwd, execOptions) => {
			const rawCommand = extractPwshUserBashCommand(command);
			if (options?.emitMarker ?? true) {
				execOptions.onData(Buffer.from("[pwsh]\n", "utf-8"));
			}
			return pwshOperations.exec(rawCommand ?? command, execCwd, execOptions);
		},
	};
}

function applyReplaceBashTools(pi: ExtensionAPI): void {
	const activeTools = pi.getActiveTools();
	const nextTools = activeTools.filter((name) => name !== "bash");
	if (!nextTools.includes("pwsh")) {
		nextTools.push("pwsh");
	}
	pi.setActiveTools(nextTools);
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const settings = readPwshToolSettings(cwd);

	const pwshOperations = createPwshOperations();
	const prefixedPwshUserBashOperations = createPwshUserBashOperations(pwshOperations);
	const replacementPwshUserBashOperations = createPwshUserBashOperations(pwshOperations, { emitMarker: false });
	const baseBashTool = createBashToolDefinition(cwd, { operations: pwshOperations });

	pi.on("session_start", () => {
		if (readPwshToolSettings(cwd).replaceBash) {
			applyReplaceBashTools(pi);
		}
	});

	pi.on("before_agent_start", () => {
		if (readPwshToolSettings(cwd).replaceBash) {
			applyReplaceBashTools(pi);
		}
	});

	pi.on("user_bash", (event) => {
		if (readPwshToolSettings(event.cwd).replaceBash) {
			return { operations: replacementPwshUserBashOperations };
		}
		if (extractPwshUserBashCommand(event.command) === null) {
			return;
		}
		return { operations: prefixedPwshUserBashOperations };
	});

	const pwshToolText = createPwshToolText(settings);
	const pwshTool: typeof baseBashTool = {
		...baseBashTool,
		...pwshToolText,
		name: "pwsh",
		label: "pwsh",
		parameters: pwshSchema,
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
	};

	pi.registerTool(pwshTool);
}
