function stableStringifyForFingerprint(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringifyForFingerprint).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableStringifyForFingerprint(entryValue)}`,
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function hashString(value: string) {
  let first = 0xdeadbeef ^ value.length;
  let second = 0x41c6ce57 ^ value.length;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }

  first =
    Math.imul(first ^ (first >>> 16), 2246822507) ^
    Math.imul(second ^ (second >>> 13), 3266489909);
  second =
    Math.imul(second ^ (second >>> 16), 2246822507) ^
    Math.imul(first ^ (first >>> 13), 3266489909);

  return `${(second >>> 0).toString(16).padStart(8, "0")}${(first >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

export function buildFeedRecordFingerprint(record: unknown) {
  return hashString(stableStringifyForFingerprint(record));
}
