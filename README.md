# pi-pwsh

A small pi package that adds a `pwsh` tool for running PowerShell commands.

It tries to behave like pi's built-in `bash` tool, including:

- similar truncation behavior
- similar output rendering
- shell shortcut behavior via `!p` / `!!p` and `!pwsh` / `!!pwsh`

> Note: this extension is carefully vibe slopped.

Currently developed for Windows, but it should (might?) work on Linux/macOS too if `pwsh` is installed.

Does not work with `powershell`, it requires `pwsh` (PowerShell 7+) in path.

## What it provides

- `pwsh` tool for executing PowerShell in the current working directory
- keeps `bash` as the default shell tool by default
- optional `pwshTool.replaceBash` setting to remove the built-in `bash` tool from the active tool list and run bang commands through PowerShell
- optional `pwshTool.availableCommands` setting to configure which commands are detected and mentioned in the tool instructions
- useful when a task is easier in PowerShell than in bash

### PowerShell tool

Ask pi to use the `pwsh` tool when PowerShell is the better fit.

Example:

```text
use pwsh to list all services
```

### PowerShell bang shortcuts

This package also supports quick PowerShell commands through pi's regular bang-command path. Bang shortcut output starts with a `[pwsh]` marker so it is clear PowerShell handled the command:

- `!p command` or `!pwsh command` — runs the command through PowerShell and includes the result in context
- `!!p command` or `!!pwsh command` — runs the command through PowerShell but excludes the result from context

Examples:

```text
!p Get-ChildItem
!!pwsh Get-Process | Sort-Object CPU -Descending | Select-Object -First 20
```

## Settings

To make PowerShell fully replace pi's integrated bash workflow, add this to `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "pwshTool": {
    "replaceBash": true
  }
}
```

When enabled:

- `bash` is removed from the active tool list
- `pwsh` remains registered as `pwsh` (it is not registered as `bash`)
- tool instructions no longer say to prefer bash
- `!command` and `!!command` run through `pwsh`

Set this in `settings.json` before starting pi; there is no interactive toggle command.

To configure which common commands are detected and mentioned in the `pwsh` tool instructions when `replaceBash` is enabled, set `pwshTool.availableCommands`:

```json
{
  "pwshTool": {
    "replaceBash": true,
    "availableCommands": ["rg", "jq", "yq", "curl"]
  }
}
```

Only commands found on PATH are included in the generated instructions.

This detection is intentionally surfaced in the tool guidelines because LLMs often assume Unix-oriented helpers such as `rg`, `jq`, or `curl` are unavailable when the shell is Windows/PowerShell. Listing the commands that are actually available helps the model use them confidently instead of falling back to slower or less appropriate alternatives.

## See also

- [marcfargas/pi-powershell](https://github.com/marcfargas/pi-powershell): Another pi PowerShell extension, with more features regarding background jobs
- [Codex PowerShell implementation](https://github.com/openai/codex/blob/d44f4205fb93ca1f602a21f110d795bd499a1e07/codex-rs/shell-command/src/powershell.rs)