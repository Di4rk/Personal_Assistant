export function maskStudentId(id: string): string {
  if (id.length < 8) return id;
  return `${id.slice(0, 4)}****`;
}

export function maskFullName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => (part.length > 1 ? `${part[0]}${'*'.repeat(part.length - 1)}` : part))
    .join(' ');
}

export function maskClassName(className: string): string {
  const match = className.match(/^([A-Za-zÀ-ỹ]+)/);
  const prefix = match ? match[1] : className.slice(0, 4);
  return `${prefix}****`;
}
