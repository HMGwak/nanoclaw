---
name: obsidian-bases
description: Create and edit Obsidian Bases (.base files) with views, filters, formulas, and summaries. Use when working with .base files, creating database-like views of notes, or when asked about Bases, table views, card views, filters, or formulas in Obsidian.
allowed-tools: Bash(shell:*), Read(*), Write(*)
---

# Obsidian Bases

Create and edit `.base` files — YAML-based database views for Obsidian vaults.

## Workflow

1. Create a `.base` file with valid YAML
2. Add `filters` to select which notes appear
3. Add `formulas` for computed properties (optional)
4. Configure `views` (table, cards, list, map) with `order` for displayed properties
5. Validate: valid YAML, all referenced properties/formulas exist

## Schema

```yaml
filters:
  and: []          # All conditions must be true
  or: []           # Any condition can be true
  not: []          # Exclude matching items

formulas:
  formula_name: 'expression'

properties:
  property_name:
    displayName: "Display Name"

summaries:
  custom_name: 'values.mean().round(3)'

views:
  - type: table | cards | list | map
    name: "View Name"
    limit: 10
    groupBy:
      property: property_name
      direction: ASC | DESC
    filters:
      and: []
    order:
      - file.name
      - property_name
      - formula.formula_name
    summaries:
      property_name: Average
```

## Filter Syntax

```yaml
# Single filter
filters: 'status == "done"'

# AND
filters:
  and:
    - 'status == "done"'
    - 'priority > 3'

# OR
filters:
  or:
    - 'file.hasTag("book")'
    - 'file.hasTag("article")'

# NOT
filters:
  not:
    - 'file.hasTag("archived")'
```

Operators: `==`, `!=`, `>`, `<`, `>=`, `<=`, `&&`, `||`, `!`

## Properties

1. **Note properties** — from frontmatter: `author` or `note.author`
2. **File properties** — metadata: `file.name`, `file.path`, `file.size`, `file.ctime`, `file.mtime`, `file.tags`, `file.links`, `file.backlinks`
3. **Formula properties** — computed: `formula.my_formula`

## Formula Syntax

```yaml
formulas:
  total: "price * quantity"
  status_icon: 'if(done, "✅", "⏳")'
  days_old: '(now() - file.ctime).days'
  days_until_due: 'if(due_date, (date(due_date) - today()).days, "")'
```

Key functions: `date()`, `now()`, `today()`, `if()`, `duration()`, `file()`, `link()`

**Duration**: subtracting dates returns Duration — access `.days`, `.hours`, `.minutes` etc. before applying number functions.

```yaml
# CORRECT
"(now() - file.ctime).days.round(0)"

# WRONG — Duration is not a number
"(now() - file.ctime).round(0)"
```

## Built-in Summaries

Number: `Average`, `Min`, `Max`, `Sum`, `Range`, `Median`, `Stddev`
Date: `Earliest`, `Latest`, `Range`
Boolean: `Checked`, `Unchecked`
Any: `Empty`, `Filled`, `Unique`

## YAML Quoting Rules

- Single quotes for formulas with double quotes: `'if(done, "Yes", "No")'`
- Double quotes for simple strings: `"My View Name"`
- Quote strings containing `:`, `{`, `}`, `[`, `]`, `#`, `!`, etc.

## Example: Task Tracker

```yaml
filters:
  and:
    - file.hasTag("task")
    - 'file.ext == "md"'

formulas:
  days_until_due: 'if(due, (date(due) - today()).days, "")'
  priority_label: 'if(priority == 1, "🔴 High", if(priority == 2, "🟡 Medium", "🟢 Low"))'

properties:
  formula.days_until_due:
    displayName: "Days Until Due"
  formula.priority_label:
    displayName: Priority

views:
  - type: table
    name: "Active Tasks"
    filters:
      and:
        - 'status != "done"'
    order:
      - file.name
      - status
      - formula.priority_label
      - due
      - formula.days_until_due
    groupBy:
      property: status
      direction: ASC
    summaries:
      formula.days_until_due: Average
```
