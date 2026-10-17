// Search and grouping for the model and filter pickers.

type Searchable = string | string[] | undefined | null;

/** True when any of the values contains `query`, which is already lower case. */
export function matchesQuery(query: string, ...values: Searchable[]): boolean {
  return values.some(value => {
    if (!value) return false;
    if (Array.isArray(value)) return value.some(entry => entry.toLowerCase().includes(query));
    return value.toLowerCase().includes(query);
  });
}

/**
 * Groups items under each of their categories. An item is listed once per
 * category however often it names it, and groups keep the items' order.
 */
export function groupByCategories<T>(
  items: T[],
  categoriesOf: (item: T) => string[],
  keyOf: (item: T) => string,
): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  const seen: Record<string, Set<string>> = {};
  for (const item of items) {
    const key = keyOf(item);
    for (const category of categoriesOf(item)) {
      const group = groups[category] ?? (groups[category] = []);
      const keys = seen[category] ?? (seen[category] = new Set());
      if (keys.has(key)) continue;
      keys.add(key);
      group.push(item);
    }
  }
  return groups;
}

/** A copy of `items` sorted by name. */
export function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}
