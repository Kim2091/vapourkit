/**
 * A template's or model's categories as a list: the stored value may be one
 * category or several. `fallback` stands in when there is no value at all.
 */
export function toCategories(category: string | string[] | undefined | null, fallback: string[] = []): string[] {
  return Array.isArray(category) ? category : (category ? [category] : fallback);
}
