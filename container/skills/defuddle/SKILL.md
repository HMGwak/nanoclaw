---
name: defuddle
description: Extract clean markdown content from web pages using Defuddle CLI, removing clutter and navigation to save tokens. Use for reading URLs, documentation, articles, or any web page.
allowed-tools: Bash(shell:*)
---

# Defuddle

Extract clean readable content from web pages. Removes navigation, ads, and clutter — saves tokens vs raw HTML fetch.

If not installed: `npm install -g defuddle`

## Usage

```bash
defuddle parse <url> --md                    # Markdown output (recommended)
defuddle parse <url> --md -o content.md      # Save to file
defuddle parse <url> --json                  # JSON with HTML + markdown
defuddle parse <url> -p title                # Extract title only
defuddle parse <url> -p description          # Extract description
defuddle parse <url> -p domain               # Extract domain
```

## Output formats

| Flag | Format |
|------|--------|
| `--md` | Markdown (default choice) |
| `--json` | JSON with both HTML and markdown |
| (none) | HTML |
| `-p <name>` | Specific metadata property |
