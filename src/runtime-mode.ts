import fs from 'fs';

const CONTAINER_CGROUP_MARKERS = [
  'docker',
  'containerd',
  'kubepods',
  'cri-containerd',
  'podman',
  'lxc',
];

export function hasContainerMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return CONTAINER_CGROUP_MARKERS.some((marker) => lower.includes(marker));
}

export function isRunningInContainer(): boolean {
  if (process.env.NANOCLAW_RUNTIME === 'docker') return true;
  if (fs.existsSync('/.dockerenv')) return true;

  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf-8');
    if (hasContainerMarker(cgroup)) return true;
  } catch {
    // Ignore platforms without /proc.
  }

  return false;
}

export function enforceContainerOnlyRuntime(): void {
  if (process.env.NANOCLAW_ALLOW_HOST_RUNTIME === '1') return;
  if (isRunningInContainer()) return;

  throw new Error(
    'Host runtime is disabled. Run NanoClaw inside Docker (or set NANOCLAW_ALLOW_HOST_RUNTIME=1 for an explicit override).',
  );
}
