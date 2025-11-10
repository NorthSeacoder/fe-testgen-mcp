export function extractRevisionId(raw: string | undefined | null): string | null {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const collapsed = trimmed.replace(/\s+/g, '');
  if (/^d\d+$/i.test(collapsed)) {
    return `D${collapsed.slice(1)}`;
  }

  const dMatch = raw.match(/[Dd]\s*\d+/);
  if (dMatch) {
    const digits = dMatch[0].replace(/[^\d]/g, '');
    if (digits) {
      return `D${digits}`;
    }
  }

  if (/^\d+$/.test(trimmed)) {
    return `D${trimmed}`;
  }

  const diffMatch = raw.match(/diff\s+(\d+)/i);
  if (diffMatch && diffMatch[1]) {
    return `D${diffMatch[1]}`;
  }

  return null;
}
