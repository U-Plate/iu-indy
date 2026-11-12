import type { FoodItem } from "@uplate/types/foods";

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/** DineOnCampus item.id identifies a menu occurrence, not a recipe. */
export async function stableFoodId(
  source: Record<string, unknown>,
  food: FoodItem
): Promise<string> {
  const fullRecipe = String(source.mrnFull ?? "").trim();
  const mrn = String(source.mrn ?? "").trim();
  const revision = String(source.rev ?? "").trim();
  const recipe = /^\d+\.\d+$/.test(fullRecipe)
    ? fullRecipe
    : /^\d+$/.test(mrn) && /^\d+$/.test(revision)
    ? `${mrn}.${revision}`
    : null;

  if (recipe) {
    // One recipe can be served in different portions with different nutrition.
    const portion = normalizedText(food.servingSize ?? "").toLowerCase();
    // Keep IDs safe to use verbatim in URL paths, object keys, and FCM topics.
    return `doc-recipe-${recipe}-portion-${await sha256(portion)}`;
  }

  // Missing recipe metadata must not send us back to occurrence IDs. Hash the
  // parsed food, excluding its temporary ID and all upstream menu metadata.
  // Sorting both fields and labels makes this independent of source ordering.
  const { id: _id, ...content } = food;
  const entries = Object.entries(content)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [
      key,
      key === "labels"
        ? JSON.parse(String(value)).sort()
        : typeof value === "string"
        ? normalizedText(value)
        : value,
    ])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  return `doc-content-${await sha256(JSON.stringify(entries))}`;
}
