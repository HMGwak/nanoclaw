# Obsidian Skills

Agent skills for working with Obsidian vaults. Teaches AI agents correct Obsidian-flavored
Markdown, Bases (.base), JSON Canvas (.canvas), CLI interaction, and web content extraction.

## Origin

- **Author**: Steph Ango (Obsidian CEO)
- **Repository**: https://github.com/kepano/obsidian-skills
- **Spec**: [Agent Skills](https://agentskills.io/specification)

## Included Skills

| Skill | Description |
|-------|-------------|
| obsidian-markdown | Wikilinks, embeds, callouts, properties, tags |
| obsidian-bases | .base files — database views with filters, formulas, summaries |
| json-canvas | .canvas files — nodes, edges, groups, visual layouts |
| obsidian-cli | CLI for reading/creating/searching notes, plugin dev |
| defuddle | Web page → clean markdown extraction |

## Usage in NanoClaw

These docs serve as the reference for container skills in `container/skills/obsidian-*`.
The catalog toolset `obsidian_vault_tools` binds these skills to agents.
