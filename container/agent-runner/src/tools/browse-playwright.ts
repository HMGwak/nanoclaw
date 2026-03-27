/**
 * Playwright browser wrapper for NanoClaw.
 * Full-control browser automation for complex tasks.
 *
 * Uses playwright-core (no bundled browser) with the container's Chromium.
 * Each call generates a script file and executes it as a subprocess,
 * so playwright-core only needs to be installed in the container, not the host.
 */

import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BrowseResult, ToolContext } from './types.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 120_000;
const CHROMIUM_PATH = process.env.AGENT_BROWSER_EXECUTABLE_PATH || '/usr/bin/chromium';
const NAV_TIMEOUT = 20_000;
const EXEC_TIMEOUT = 30_000;

async function runScript(
  scriptBody: string,
  ctx: ToolContext,
): Promise<{ stdout: string; ok: boolean; error?: string }> {
  const scriptPath = '/tmp/pw-script.cjs';
  const script = `
const { chromium } = require('/app/node_modules/playwright-core');
(async () => {
const browser = await chromium.launch({
  executablePath: '${CHROMIUM_PATH}',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  ${scriptBody}
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err.message }));
} finally {
  await browser.close();
}
})();
`;
  fs.writeFileSync(scriptPath, script);

  const env = Object.fromEntries(
    Object.entries(ctx.env).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );

  try {
    const { stdout, stderr } = await execFileAsync('node', [scriptPath], {
      timeout: EXEC_TIMEOUT,
      maxBuffer: MAX_OUTPUT * 2,
      env,
    });
    if (stderr) ctx.log(`playwright stderr: ${stderr.slice(0, 200)}`);
    return { stdout, ok: true };
  } catch (err) {
    const e = err as { stdout?: string; message?: string };
    return { stdout: e.stdout || '', ok: false, error: e.message };
  }
}

function parseLastLine(stdout: string): BrowseResult {
  const lastLine = stdout.trim().split('\n').pop() || '{}';
  try {
    return JSON.parse(lastLine);
  } catch {
    return { ok: true, text: stdout.trim() };
  }
}

/** Open a URL, extract text content and metadata. */
export async function playwrightOpen(
  url: string,
  ctx: ToolContext,
): Promise<BrowseResult> {
  ctx.log(`playwright: open ${url}`);
  const safeUrl = url.replace(/'/g, "\\'");
  const res = await runScript(`
  await page.goto('${safeUrl}', { waitUntil: 'networkidle', timeout: ${NAV_TIMEOUT} });
  const title = await page.title();
  const text = await page.innerText('body').catch(() => '');
  console.log(JSON.stringify({ ok: true, url: page.url(), title, text: text.slice(0, ${MAX_OUTPUT}) }));
  `, ctx);
  if (!res.ok) return { ok: false, error: res.error };
  return parseLastLine(res.stdout);
}

/** Take a screenshot. Returns base64 PNG. */
export async function playwrightScreenshot(
  url: string,
  ctx: ToolContext,
  options?: { fullPage?: boolean; selector?: string },
): Promise<BrowseResult> {
  ctx.log(`playwright: screenshot ${url}`);
  const safeUrl = url.replace(/'/g, "\\'");
  const ssPath = '/tmp/pw-screenshot.png';
  let ssCmd: string;
  if (options?.selector) {
    const safeSel = options.selector.replace(/'/g, "\\'");
    ssCmd = `await page.locator('${safeSel}').screenshot({ path: '${ssPath}' });`;
  } else {
    ssCmd = `await page.screenshot({ path: '${ssPath}', fullPage: ${options?.fullPage ?? false} });`;
  }
  const res = await runScript(`
  await page.goto('${safeUrl}', { waitUntil: 'networkidle', timeout: ${NAV_TIMEOUT} });
  ${ssCmd}
  const fs = await import('fs');
  const b64 = fs.readFileSync('${ssPath}').toString('base64');
  fs.unlinkSync('${ssPath}');
  console.log(JSON.stringify({ ok: true, screenshot: b64 }));
  `, ctx);
  if (!res.ok) return { ok: false, error: res.error };
  return parseLastLine(res.stdout);
}

/** Execute custom Playwright actions on a page. */
export async function playwrightExecute(
  url: string,
  actions: string,
  ctx: ToolContext,
): Promise<BrowseResult> {
  ctx.log(`playwright: execute on ${url}`);
  const safeUrl = url.replace(/'/g, "\\'");
  const res = await runScript(`
  await page.goto('${safeUrl}', { waitUntil: 'networkidle', timeout: ${NAV_TIMEOUT} });
  ${actions}
  const title = await page.title();
  const text = await page.innerText('body').catch(() => '');
  console.log(JSON.stringify({ ok: true, url: page.url(), title, text: text.slice(0, ${MAX_OUTPUT}) }));
  `, ctx);
  if (!res.ok) return { ok: false, error: res.error };
  return parseLastLine(res.stdout);
}

/** Extract structured data using CSS selectors. */
export async function playwrightExtract(
  url: string,
  selectors: Record<string, string>,
  ctx: ToolContext,
): Promise<BrowseResult> {
  ctx.log(`playwright: extract from ${url}`);
  const safeUrl = url.replace(/'/g, "\\'");
  const entries = Object.entries(selectors)
    .map(([k, s]) => `'${k}': await page.locator('${s.replace(/'/g, "\\'")}').allInnerTexts().catch(() => [])`)
    .join(',\n    ');
  const res = await runScript(`
  await page.goto('${safeUrl}', { waitUntil: 'networkidle', timeout: ${NAV_TIMEOUT} });
  const data = { ${entries} };
  console.log(JSON.stringify({ ok: true, text: JSON.stringify(data, null, 2) }));
  `, ctx);
  if (!res.ok) return { ok: false, error: res.error };
  return parseLastLine(res.stdout);
}

/** Generate PDF. Returns base64. */
export async function playwrightPdf(
  url: string,
  ctx: ToolContext,
): Promise<BrowseResult> {
  ctx.log(`playwright: pdf ${url}`);
  const safeUrl = url.replace(/'/g, "\\'");
  const pdfPath = '/tmp/pw-page.pdf';
  const res = await runScript(`
  await page.goto('${safeUrl}', { waitUntil: 'networkidle', timeout: ${NAV_TIMEOUT} });
  await page.pdf({ path: '${pdfPath}', format: 'A4' });
  const fs = await import('fs');
  const b64 = fs.readFileSync('${pdfPath}').toString('base64');
  fs.unlinkSync('${pdfPath}');
  console.log(JSON.stringify({ ok: true, text: b64 }));
  `, ctx);
  if (!res.ok) return { ok: false, error: res.error };
  return parseLastLine(res.stdout);
}
