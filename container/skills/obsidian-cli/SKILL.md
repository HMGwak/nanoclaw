---
name: obsidian-cli
description: Interact with Obsidian vaults using the Obsidian CLI to read, create, search, and manage notes, tasks, properties, and more. Use when asked to interact with an Obsidian vault, manage notes, or search vault content from the command line.
allowed-tools: Bash(shell:*)
---

# Obsidian CLI

Use the `obsidian` CLI to interact with a running Obsidian instance. Requires Obsidian to be open.

Run `obsidian help` for all available commands.

## Syntax

**Parameters** take a value with `=`. Quote values with spaces:

```bash
obsidian create name="My Note" content="Hello world"
```

**Flags** are boolean switches with no value:

```bash
obsidian create name="My Note" silent overwrite
```

## File targeting

- `file=<name>` — resolves like a wikilink (name only, no path or extension)
- `path=<path>` — exact path from vault root (e.g., `folder/note.md`)
- Neither → targets the active file

## Vault targeting

```bash
obsidian vault="My Vault" search query="test"
```

## Common patterns

```bash
obsidian read file="My Note"
obsidian create name="New Note" content="# Hello" template="Template" silent
obsidian append file="My Note" content="New line"
obsidian search query="search term" limit=10
obsidian daily:read
obsidian daily:append content="- [ ] New task"
obsidian property:set name="status" value="done" file="My Note"
obsidian tasks daily todo
obsidian tags sort=count counts
obsidian backlinks file="My Note"
```

Flags: `--copy` (clipboard), `silent` (don't open file), `total` (count only).

## Plugin development

1. **Reload**: `obsidian plugin:reload id=my-plugin`
2. **Check errors**: `obsidian dev:errors`
3. **Screenshot**: `obsidian dev:screenshot path=screenshot.png`
4. **DOM inspect**: `obsidian dev:dom selector=".workspace-leaf" text`
5. **Console**: `obsidian dev:console level=error`
6. **Eval JS**: `obsidian eval code="app.vault.getFiles().length"`
7. **CSS inspect**: `obsidian dev:css selector=".workspace-leaf" prop=background-color`
8. **Mobile emulation**: `obsidian dev:mobile on`
