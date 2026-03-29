# Content Endpoint Contract

Preserved contract for Cloudflare Browser Rendering `content` endpoint.

## Purpose

- Fetch rendered page content from a target URL through Cloudflare-managed browser execution.

## Input Shape (logical)

- `url`: target URL to render
- `gotoOptions.waitUntil`: optional load strategy

## Output Shape (logical)

- Success flag
- Rendered content payload (`result` as rendered text/html string payload)
- Error list when request fails

## Integration Notes

- NanoClaw uses this as the first browser retrieval step in the browser stack.
- Credentials required:
  - `CF_ACCOUNT_ID`
  - `CF_API_TOKEN`
