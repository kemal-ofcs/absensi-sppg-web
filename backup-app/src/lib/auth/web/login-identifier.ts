export function normalizeLoginIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

export function buildLoginEmailCandidates(identifier: string): string[] {
  const normalized = normalizeLoginIdentifier(identifier);
  if (!normalized) {
    return [];
  }

  if (normalized.includes("@")) {
    return [normalized];
  }

  const candidates = new Set<string>();
  candidates.add(normalized);
  candidates.add(`${normalized}@starter.local`);

  return [...candidates];
}
