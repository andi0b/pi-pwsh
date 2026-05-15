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
- keeps `bash` as the default shell tool
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

## See also

- [marcfargas/pi-powershell](https://github.com/marcfargas/pi-powershell): Another pi PowerShell extension, with more features regarding background jobs
- [Codex PowerShell implementation](https://github.com/openai/codex/blob/d44f4205fb93ca1f602a21f110d795bd499a1e07/codex-rs/shell-command/src/powershell.rs)