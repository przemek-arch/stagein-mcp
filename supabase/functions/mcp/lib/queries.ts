/**
 * Apply standard event filters: status='active' AND event_date >= today.
 * Generic over query builder — preserves chained call site typing.
 *
 * Method shape uses `unknown` for filter values because Postgrest filter builder
 * accepts heterogeneous types (string, number, boolean, null, array). The shape
 * constraint is what matters here — that the object has chainable .eq() and .gte().
 */
export function activeUpcomingEvents<
  T extends {
    eq: (column: string, value: unknown) => T;
    gte: (column: string, value: unknown) => T;
  }
>(qb: T): T {
  const today = new Date().toISOString().slice(0, 10);
  return qb.eq("status", "active").gte("event_date", today);
}

/**
 * Apply standard listing filter: is_available = true.
 */
export function availableListings<
  T extends {
    eq: (column: string, value: unknown) => T;
  }
>(qb: T): T {
  return qb.eq("is_available", true);
}
