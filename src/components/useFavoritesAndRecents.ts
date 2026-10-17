import { useCallback, useEffect, useState } from 'react';

export const MAX_RECENT = 10;

export interface RecentEntry {
  key: string;
  lastUsed: number;
}

export interface FavoritesAndRecentsStore {
  /** localStorage key of the favourites: a JSON array of item keys. */
  favoritesKey: string;
  /** localStorage key of the recents: a JSON array of `{ [field]: key, lastUsed }`. */
  recentKey: string;
  /** The property that holds an item's key in a stored recent entry. */
  field: string;
  /** What the items are, for error messages: "filter", "model". */
  what: string;
}

/**
 * Reads stored recents, newest first, without duplicates and at most
 * MAX_RECENT long. Plain strings (an older format) are read as entries
 * last used at time 0.
 */
export function normalizeRecents(value: unknown, field: string): RecentEntry[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: RecentEntry[] = [];

  value.forEach(item => {
    const key = typeof item === 'string'
      ? item
      : (item && typeof item === 'object' && typeof (item as Record<string, unknown>)[field] === 'string'
          ? (item as Record<string, string>)[field]
          : '');

    if (!key || seen.has(key)) return;

    const lastUsed = item && typeof item === 'object' && typeof (item as { lastUsed?: unknown }).lastUsed === 'number'
      ? (item as { lastUsed: number }).lastUsed
      : 0;

    normalized.push({ key, lastUsed });
    seen.add(key);
  });

  return normalized
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, MAX_RECENT);
}

/** The stored form of the recents. */
export function serializeRecents(recents: RecentEntry[], field: string): string {
  return JSON.stringify(recents.map(entry => ({ [field]: entry.key, lastUsed: entry.lastUsed })));
}

/** Moves `key` to the front of the recents, keeping at most MAX_RECENT. */
export function pushRecent(recents: RecentEntry[], key: string, now: number): RecentEntry[] {
  return [{ key, lastUsed: now }, ...recents.filter(entry => entry.key !== key)].slice(0, MAX_RECENT);
}

/**
 * A picker's favourite and recently used items, kept in localStorage.
 * Items are identified by a string key (a filter's name, a model's path).
 */
export function useFavoritesAndRecents({ favoritesKey, recentKey, field, what }: FavoritesAndRecentsStore) {
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [recents, setRecents] = useState<RecentEntry[]>([]);

  useEffect(() => {
    try {
      const storedFavorites = localStorage.getItem(favoritesKey);
      if (storedFavorites) {
        setFavorites(new Set(JSON.parse(storedFavorites)));
      }
      const storedRecent = localStorage.getItem(recentKey);
      if (storedRecent) {
        const normalized = normalizeRecents(JSON.parse(storedRecent), field);
        setRecents(normalized);
        localStorage.setItem(recentKey, serializeRecents(normalized, field));
      }
    } catch (error) {
      console.error(`Failed to load ${what} preferences:`, error);
    }
  }, [favoritesKey, recentKey, field, what]);

  const saveFavorites = useCallback((next: Set<string>) => {
    try {
      localStorage.setItem(favoritesKey, JSON.stringify([...next]));
    } catch (error) {
      console.error('Failed to save favorites:', error);
    }
  }, [favoritesKey]);

  const saveRecents = useCallback((next: RecentEntry[]) => {
    try {
      localStorage.setItem(recentKey, serializeRecents(next, field));
    } catch (error) {
      console.error(`Failed to save recent ${what}s:`, error);
    }
  }, [recentKey, field, what]);

  const toggleFavorite = useCallback((key: string) => {
    setFavorites(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      saveFavorites(next);
      return next;
    });
  }, [saveFavorites]);

  const addRecent = useCallback((key: string) => {
    setRecents(prev => {
      const next = pushRecent(prev, key, Date.now());
      saveRecents(next);
      return next;
    });
  }, [saveRecents]);

  /** Drops an item that no longer exists from both lists. */
  const forget = useCallback((key: string) => {
    setFavorites(prev => {
      const next = new Set(prev);
      next.delete(key);
      saveFavorites(next);
      return next;
    });
    setRecents(prev => {
      const next = prev.filter(entry => entry.key !== key);
      saveRecents(next);
      return next;
    });
  }, [saveFavorites, saveRecents]);

  /** Carries an item's place in both lists over to its new key. */
  const rename = useCallback((oldKey: string, newKey: string) => {
    if (oldKey === newKey) return;
    setFavorites(prev => {
      if (!prev.has(oldKey)) return prev;
      const next = new Set(prev);
      next.delete(oldKey);
      next.add(newKey);
      saveFavorites(next);
      return next;
    });
    setRecents(prev => {
      const next = prev.map(entry => (entry.key === oldKey ? { ...entry, key: newKey } : entry));
      saveRecents(next);
      return next;
    });
  }, [saveFavorites, saveRecents]);

  return { favorites, recents, toggleFavorite, addRecent, forget, rename };
}
