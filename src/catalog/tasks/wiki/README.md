# Wiki Module Guide

This directory contains the wiki generation runtime for domain-scoped specs.

## What is the entrypoint?

Use only `run_wiki.py`.

There is no separate generic layer runner anymore. Layer execution order and layer source selection are driven by the spec file for the selected domain.

## Core files

- `run_wiki.py` - single CLI entrypoint for wiki generation
- `spec_loader.py` - loads one domain-scoped JSON spec file
- `base_index.py` - resolves `.base` files, views, and frontmatter filter expressions
- `task.py` - wiki generation core used by the quality loop
- `synthesizer.py` - extract/compose/update synthesis logic
- `specs/<domain>.json` - per-domain source of truth

## Spec format

Each domain has one JSON file under `specs/`.

Example path:
- `specs/tobacco_regulation.json`

Logical structure:

```json
{
  "domain": "tobacco_regulation",
  "version": "v1",
  "structure": { "...": "final wiki heading tree" },
  "shared_prompt_rules": {
    "extract": "shared extract rules",
    "compose": "shared compose/update/revise rules"
  },
  "runner": {
    "vault_root_default": "~/Documents/Mywork",
    "index_root": "3. Resource/LLM Knowledge Base/index",
    "wiki_root": "3. Resource/LLM Knowledge Base/wiki"
  },
  "layers": {
    "layer1": {
      "source": { "view": "Tobacco Law" },
      "prompt": {
        "extract": { "version": "v1", "prompt": "..." },
        "compose": { "version": "v1", "prompt": "..." },
        "revise": { "version": "v1", "prompt": "..." }
      },
      "evaluation": { "version": "v1", "loop": { }, "scoring": { } }
    }
  }
}
```

### Ownership rules

- `structure` is domain-wide and shared across all layers
- `shared_prompt_rules` are prepended by the runner to layer prompts
- `layers` decides orchestration depth
  - if only `layer1` exists, the run executes once
  - if `layer1`, `layer2`, `layer3` exist, the run executes in that order
- each `layers.<layer>.source.view` selects which `.base` view is used for that layer

## CLI usage

Basic form:

```bash
python src/catalog/tasks/wiki/run_wiki.py \
  --domain tobacco_regulation \
  --wiki-output-dir tobacco_regulation
```

With a frontmatter filter:

```bash
python src/catalog/tasks/wiki/run_wiki.py \
  --domain tobacco_regulation \
  --wiki-output-dir tobacco_regulation \
  --filter '(country="Taiwan _China")'
```

Preview without LLM calls:

```bash
python src/catalog/tasks/wiki/run_wiki.py \
  --domain tobacco_regulation \
  --wiki-output-dir tobacco_regulation \
  --filter '(country="Taiwan _China")' \
  --dry-run
```

## CLI arguments

- `--domain`
  - required
  - domain key and index filename without `.base`
  - example: `tobacco_regulation`

- `--wiki-output-dir`
  - required
  - subdirectory under the wiki root

- `--filter`
  - optional
  - frontmatter boolean filter expression

- `--spec-path`
  - optional
  - if omitted, uses `src/catalog/tasks/wiki/specs/{domain}.json`

- `--vault-root`
  - optional
  - defaults to `~/Documents/Mywork`

- `--max-docs`
  - optional
  - limits discovered docs for smoke runs

- `--output`
  - optional
  - explicit work directory override

- `--dry-run`
  - optional
  - prints per-layer view and doc counts without running the model loop

## Filter grammar

Supported operators:

- `+` = AND
- `|` = OR
- parentheses for grouping
- `field="value"` equality

Examples:

```text
(country="Taiwan _China")
(country="Germany")|(region="European Union")
((field1="value1")+(field2="value2"))|(field3="value3")
```

The filter is applied as an AND restriction on top of each layer's source result set.

## Path resolution

Given:
- domain = `tobacco_regulation`
- vault root = `~/Documents/Mywork`

The runner resolves:

- base file:
  - `~/Documents/Mywork/3. Resource/LLM Knowledge Base/index/tobacco_regulation.base`

- wiki output root:
  - `~/Documents/Mywork/3. Resource/LLM Knowledge Base/wiki/<wiki-output-dir>`

Work directory defaults to:

- `~/.nanoclaw/wiki-runs/<domain>/<run-id>/` inside the vault root

## Dry-run output

Expected shape:

```text
[layer1] view=Tobacco Law docs=10
[layer2] view=Law Reviews docs=13
[layer3] view=첨가물 제출 docs=45
```

This is the recommended first check before a real run.

## Verification commands

Compile relevant files:

```bash
python -m py_compile src/catalog/tasks/wiki/spec_loader.py \
  src/catalog/tasks/wiki/base_index.py \
  src/catalog/tasks/wiki/task.py \
  src/catalog/tasks/wiki/run_wiki.py
```

Smoke tests:

```bash
uv run --python ./.venv/bin/python3 --with pytest \
  pytest tests/wiki/test_spec_loader.py tests/wiki/test_spec_wiring.py -v
```

## Current migration status

- generic runtime uses JSON spec
- `run_wiki.py` is the only generic entrypoint
- layer discovery is spec-driven
- layer source view is spec-driven

If additional cleanup is needed, it should happen by updating the spec and the generic runner, not by adding new runner files.
