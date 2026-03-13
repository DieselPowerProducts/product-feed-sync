import { readFileSync } from "node:fs";
import path from "node:path";

const TAXONOMY_PATH = path.join(
  process.cwd(),
  "data",
  "google-taxonomy-with-ids.en-US.txt",
);

type GoogleTaxonomyIndex = {
  idToPath: Map<string, string>;
  normalizedPathToId: Map<string, string>;
  normalizedLeafToIds: Map<string, string[]>;
};

let cachedIndex: GoogleTaxonomyIndex | null = null;

function normalizeValue(value: string | null | undefined) {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function appendLeafId(
  normalizedLeafToIds: Map<string, string[]>,
  leaf: string,
  id: string,
) {
  const existing = normalizedLeafToIds.get(leaf);

  if (!existing) {
    normalizedLeafToIds.set(leaf, [id]);
    return;
  }

  if (!existing.includes(id)) {
    existing.push(id);
  }
}

function loadTaxonomyIndex() {
  if (cachedIndex) {
    return cachedIndex;
  }

  const idToPath = new Map<string, string>();
  const normalizedPathToId = new Map<string, string>();
  const normalizedLeafToIds = new Map<string, string[]>();
  const contents = readFileSync(TAXONOMY_PATH, "utf8");

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^(\d+)\s+-\s+(.+)$/);

    if (!match) {
      continue;
    }

    const [, id, fullPath] = match;
    const normalizedPath = normalizeValue(fullPath);
    const leaf = normalizeValue(fullPath.split(">").pop());

    idToPath.set(id, fullPath);
    normalizedPathToId.set(normalizedPath, id);
    appendLeafId(normalizedLeafToIds, leaf, id);
  }

  cachedIndex = {
    idToPath,
    normalizedPathToId,
    normalizedLeafToIds,
  };

  return cachedIndex;
}

export function resolveGoogleProductCategoryId(value: string | null) {
  const normalized = normalizeValue(value);

  if (!normalized) {
    return null;
  }

  const taxonomy = loadTaxonomyIndex();

  if (/^\d+$/.test(normalized)) {
    return normalized;
  }

  const exactMatchId = taxonomy.normalizedPathToId.get(normalized);

  if (exactMatchId) {
    return exactMatchId;
  }

  const candidateIds = taxonomy.normalizedLeafToIds.get(normalized) ?? [];

  if (candidateIds.length === 1) {
    return candidateIds[0];
  }

  return value?.trim() ?? null;
}
