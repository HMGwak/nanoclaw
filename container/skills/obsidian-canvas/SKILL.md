---
name: obsidian-canvas
description: Create and edit JSON Canvas files (.canvas) with nodes, edges, groups, and connections. Use when working with .canvas files, creating visual canvases, mind maps, flowcharts, or when asked about Canvas files in Obsidian.
allowed-tools: Bash(shell:*), Read(*), Write(*)
---

# JSON Canvas (.canvas)

Create and edit Obsidian Canvas files following JSON Canvas Spec 1.0.

## File Structure

```json
{
  "nodes": [],
  "edges": []
}
```

## Workflow

1. Create `.canvas` file with `{"nodes": [], "edges": []}`
2. Generate unique 16-char hex IDs for each node (e.g., `"6f0ad84f44ce9c17"`)
3. Add nodes with required: `id`, `type`, `x`, `y`, `width`, `height`
4. Add edges referencing valid node IDs via `fromNode`/`toNode`
5. Validate: unique IDs, all edge references resolve, valid JSON

## Node Types

### Text Node

```json
{
  "id": "6f0ad84f44ce9c17",
  "type": "text",
  "x": 0, "y": 0, "width": 400, "height": 200,
  "text": "# Hello World\n\nThis is **Markdown** content."
}
```

Use `\n` for line breaks (not literal `\\n`).

### File Node

```json
{
  "id": "a1b2c3d4e5f67890",
  "type": "file",
  "x": 500, "y": 0, "width": 400, "height": 300,
  "file": "Attachments/diagram.png",
  "subpath": "#Heading"
}
```

### Link Node

```json
{
  "id": "c3d4e5f678901234",
  "type": "link",
  "x": 1000, "y": 0, "width": 400, "height": 200,
  "url": "https://obsidian.md"
}
```

### Group Node

```json
{
  "id": "d4e5f6789012345a",
  "type": "group",
  "x": -50, "y": -50, "width": 1000, "height": 600,
  "label": "Project Overview",
  "color": "4"
}
```

## Edges

```json
{
  "id": "0123456789abcdef",
  "fromNode": "6f0ad84f44ce9c17",
  "fromSide": "right",
  "toNode": "a1b2c3d4e5f67890",
  "toSide": "left",
  "toEnd": "arrow",
  "label": "leads to"
}
```

Side values: `top`, `right`, `bottom`, `left`
End values: `none`, `arrow` (default: `toEnd` = `arrow`, `fromEnd` = `none`)

## Colors

Presets `"1"`-`"6"` (Red, Orange, Yellow, Green, Cyan, Purple) or hex `"#FF0000"`.

## Layout Guidelines

- Coordinates can be negative; `x` → right, `y` → down
- Space nodes 50-100px apart; 20-50px padding inside groups
- Align to grid (multiples of 20)

| Node Type | Width | Height |
|-----------|-------|--------|
| Small text | 200-300 | 80-150 |
| Medium text | 300-450 | 150-300 |
| File preview | 300-500 | 200-400 |
| Link preview | 250-400 | 100-200 |

## Validation Checklist

1. All `id` values unique across nodes and edges
2. Every `fromNode`/`toNode` references existing node ID
3. Required fields present per node type
4. `type` is `text`, `file`, `link`, or `group`
5. Valid JSON parseable
