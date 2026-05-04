-- Migration: RPC for fuzzy artist search + their upcoming events
-- Phase 2A-3 fix — replaces the substring-only ilike implementation with
-- proper trigram fuzzy matching, AND collapses N+1 query (was 1 + N round
-- trips) into a single round trip via jsonb_agg.
--
-- Matching logic:
--   1. pg_trgm % operator (fuzzy similarity, default threshold 0.3) — uses idx_artists_name_trgm
--   2. ILIKE substring fallback — case-insensitive substring match
--   3. Union of both — gets typos AND substring matches
--   4. Ranking: substring matches first, then by trigram similarity DESC

CREATE OR REPLACE FUNCTION public.search_artists_with_events_rpc(
  query_text text,
  events_per_artist integer DEFAULT 10,
  today_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  artist_id uuid,
  artist_name text,
  artist_image_url text,
  artist_followers integer,
  similarity_score real,
  contains_substring boolean,
  events jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  WITH matched_artists AS (
    SELECT
      a.id,
      a.name,
      a.spotify_image_url,
      a.spotify_followers,
      similarity(a.name, query_text) AS sim,
      (a.name ILIKE '%' || query_text || '%') AS contains
    FROM artists a
    WHERE
      a.name % query_text
      OR a.name ILIKE '%' || query_text || '%'
    ORDER BY
      (a.name ILIKE '%' || query_text || '%') DESC,
      similarity(a.name, query_text) DESC
    LIMIT 5
  )
  SELECT
    ma.id,
    ma.name,
    ma.spotify_image_url,
    ma.spotify_followers,
    ma.sim::real,
    ma.contains,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', e.id,
            'title', e.title,
            'subtitle', e.subtitle,
            'event_date', e.event_date,
            'event_time', e.event_time,
            'price_min', e.price_min,
            'price_max', e.price_max,
            'category', e.category,
            'slug', e.slug,
            'image_url', e.image_url,
            'is_hot', e.is_hot,
            'venue_id', v.id,
            'venue_name', v.name,
            'venue_city', v.city,
            'venue_region', v.region
          )
        )
        FROM (
          SELECT *
          FROM events
          WHERE artist_id = ma.id
            AND status = 'active'
            AND event_date >= today_date
          ORDER BY event_date ASC
          LIMIT events_per_artist
        ) e
        LEFT JOIN venues v ON v.id = e.venue_id
      ),
      '[]'::jsonb
    ) AS events
  FROM matched_artists ma
  ORDER BY ma.contains DESC, ma.sim DESC;
$$;

COMMENT ON FUNCTION public.search_artists_with_events_rpc IS
  'Fuzzy artist search with their upcoming events. Uses pg_trgm % operator + ILIKE fallback in single round trip. Phase 2A-3 fix.';
