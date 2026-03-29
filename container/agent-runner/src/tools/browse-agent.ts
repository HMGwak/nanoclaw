/**
 * agent-browser (Vercel) wrapper for NanoClaw.
 * Token-efficient browser automation via accessibility tree snapshots.
 *
 * Uses the globally installed `agent-browser` CLI.
 * Each action returns a snapshot with refs (@e1, @e2, ...) for follow-up.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { BrowseResult, BrowseSnapshot, ToolContext } from './types.js';

const execFileAsync = promisify(execFile);
const AGENT_BROWSER = 'agent-browser';
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 100_000;

async function run(
  args: string[],
  ctx: ToolContext,
): Promise<{ stdout: string; stderr: string; ok: boolean; error?: string }> {
  const env = Object.fromEntries(
    Object.entries(ctx.env).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
  try {
    const { stdout, stderr } = await execFileAsync(AGENT_BROWSER, args, {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT * 2,
      env,
    });
    return { stdout, stderr, ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      ok: false,
      error: e.message,
    };
  }
}

async function takeSnapshot(ctx: ToolContext): Promise<BrowseSnapshot> {
  const [snapshotRes, urlRes, titleRes] = await Promise.all([
    run(['snapshot', '-i'], ctx),
    run(['get', 'url'], ctx),
    run(['get', 'title'], ctx),
  ]);
  return {
    url: urlRes.stdout.trim(),
    title: titleRes.stdout.trim(),
    elements: snapshotRes.stdout.trim(),
  };
}

/** Open a URL and return the accessibility snapshot. */
export async function agentBrowseOpen(
  url: string,
  ctx: ToolContext,
): Promise<BrowseResult> {
  ctx.log(`agent-browser: open ${url}`);
  const res = await run(['open', url], ctx);
  if (!res.ok) {
    return {
      ok: false,
      error: `Failed to open: ${res.stderr || res.error || 'unknown error'}`,
    };
  }
  // Wait for page load
  await run(['wait', '--load', 'networkidle'], ctx);
  const snapshot = await takeSnapshot(ctx);
  return { ok: true, snapshot };
}

/** Click an element by ref and return updated snapshot. */
export async function agentBrowseClick(
  ref: string,
  ctx: ToolContext,
): Promise<BrowseResult> {
  ctx.log(`agent-browser: click ${ref}`);
  const res = await run(['click', ref], ctx);
  if (!res.ok) {
    return {
      ok: false,
      error: `Click failed: ${res.stderr || res.error || 'unknown error'}`,
    };
  }
  const snapshot = await takeSnapshot(ctx);
  return { ok: true, snapshot };
}

/** Fill a form field by ref. */
export async function agentBrowseFill(
  ref: string,
  text: string,
  ctx: ToolContext,
): Promise<BrowseResult> {
  ctx.log(`agent-browser: fill ${ref} "${text.slice(0, 50)}"`);
  const res = await run(['fill', ref, text], ctx);
  if (!res.ok) {
    return {
      ok: false,
      error: `Fill failed: ${res.stderr || res.error || 'unknown error'}`,
    };
  }
  const snapshot = await takeSnapshot(ctx);
  return { ok: true, snapshot };
}

/** Select a dropdown option by ref. */
export async function agentBrowseSelect(
  ref: string,
  option: string,
  ctx: ToolContext,
): Promise<BrowseResult> {
  ctx.log(`agent-browser: select ${ref} "${option}"`);
  const res = await run(['select', ref, option], ctx);
  if (!res.ok) {
    return {
      ok: false,
      error: `Select failed: ${res.stderr || res.error || 'unknown error'}`,
    };
  }
  const snapshot = await takeSnapshot(ctx);
  return { ok: true, snapshot };
}

/** Get the current page snapshot without performing any action. */
export async function agentBrowseSnapshot(
  ctx: ToolContext,
): Promise<BrowseResult> {
  ctx.log('agent-browser: snapshot');
  const snapshot = await takeSnapshot(ctx);
  return { ok: true, snapshot };
}

/** Take a screenshot (returns base64 PNG). */
export async function agentBrowseScreenshot(
  ctx: ToolContext,
): Promise<BrowseResult> {
  ctx.log('agent-browser: screenshot');
  const path = '/tmp/ab-screenshot.png';
  const res = await run(['screenshot', path], ctx);
  if (!res.ok) {
    return {
      ok: false,
      error: `Screenshot failed: ${res.stderr || res.error || 'unknown error'}`,
    };
  }
  const fs = await import('fs');
  if (fs.existsSync(path)) {
    const base64 = fs.readFileSync(path).toString('base64');
    fs.unlinkSync(path);
    return { ok: true, screenshot: base64 };
  }
  return { ok: false, error: 'Screenshot file not created' };
}

/** Extract text content from an element or the entire page. */
export async function agentBrowseGetText(
  ref: string | undefined,
  ctx: ToolContext,
): Promise<BrowseResult> {
  const args = ref ? ['get', 'text', ref] : ['get', 'text'];
  ctx.log(`agent-browser: get text ${ref || '(page)'}`);
  const res = await run(args, ctx);
  return { ok: res.ok, text: res.stdout.trim(), error: res.ok ? undefined : res.stderr };
}

/** Press a keyboard key. */
export async function agentBrowsePress(
  key: string,
  ctx: ToolContext,
): Promise<BrowseResult> {
  ctx.log(`agent-browser: press ${key}`);
  const res = await run(['press', key], ctx);
  if (!res.ok) {
    return {
      ok: false,
      error: `Press failed: ${res.stderr || res.error || 'unknown error'}`,
    };
  }
  const snapshot = await takeSnapshot(ctx);
  return { ok: true, snapshot };
}

/** Close the browser session. */
export async function agentBrowseClose(
  ctx: ToolContext,
): Promise<BrowseResult> {
  ctx.log('agent-browser: close');
  const res = await run(['close', '--all'], ctx);
  return {
    ok: res.ok,
    error: res.ok ? undefined : res.stderr || res.error || 'unknown error',
  };
}
