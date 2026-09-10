export interface ClientKeyLabel {
  id: string;
  label: string;
}

const keyIdPattern = /^key-[a-f0-9]{24}$/;

export function clientKeyLabels(value: unknown): Map<string, string> {
  const labels = new Map<string, string>();
  if (!Array.isArray(value)) return labels;
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { id, label } = item as Partial<ClientKeyLabel>;
    if (typeof id === 'string' && keyIdPattern.test(id) && typeof label === 'string' && label.trim()) {
      labels.set(id, label.trim());
    }
  }
  return labels;
}

export function resolveClientKeyLabel(
  value: unknown,
  labels: ReadonlyMap<string, string>,
  unmatchedLabel: string,
): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id === 'unknown') return '-';
  const label = labels.get(id);
  if (label) return label;
  // A stored fingerprint is an identity, never a credential to mask again.
  return keyIdPattern.test(id) ? `${unmatchedLabel} · ${id.slice(-8)}` : unmatchedLabel;
}
