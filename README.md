# pi-pwsh

A small pi package that adds a `pwsh` tool for running PowerShell commands.

Currently developed for Windows, but it should (might?) work on Linux/macOS too if `pwsh` is installed

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

This package also supports quick PowerShell commands directly from the input line:

- `> command` — runs the command through PowerShell and includes the result in context
- `>> command` — runs the command through PowerShell but excludes the result from context

Examples:

```text
> Get-ChildItem
>> Get-Process | Sort-Object CPU -Descending | Select-Object -First 20
```

These are converted into pi bang commands internally and executed with `pwsh`.
