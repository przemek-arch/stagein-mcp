-- Migration: RPC for similar event recommendations
-- Phase 2A-4 — multi-signal scoring
--
-- Scoring:
--   Same artist          → +100
--   Genre overlap (any)  → +20 per overlapping genre
--   Same category + city → +30
--   Same category alone  → +10

CREATE OR REPLACE FUNCTION public.recommend_similar_events_rpc(
  seed_event_id uuid,
  result_limit integer DEFAULT 10,
  today_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  event_id uuid,
  title text,
  event_date date,
  category text,
  price_min numeric,
  slug text,
  venue_name text,
  venue_city text,
  artist_name text,
  artist_image_url text,
  similarity_score integer,
  similarity_reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  seed_artist_id uuid;
  seed_genres text[];
  seed_category text;
  seed_city text;
BEGIN
  SELECT e.artist_id, COALESCE(a.spotify_genres, '{}'::text[]), e.category, v.city
    INTO seed_artist_id, seed_genres, seed_category, seed_city
  FROM events e
  LEFT JOIN artists a ON a.id = e.artist_id
  LEFT JOIN venues v ON v.id = e.venue_id
  WHERE e.id = seed_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Seed event % not found', seed_event_id;
  END IF;

  RETURN QUERY
  SELECT
    e.id,
    e.title,
    e.event_date,
    e.category,
    e.price_min,
    e.slug,
    v.name AS venue_name,
    v.city AS venue_city,
    a.name AS artist_name,
    a.spotify_image_url AS artist_image_url,
    (
      CASE WHEN e.artist_id IS NOT NULL AND e.artist_id = seed_artist_id THEN 100 ELSE 0 END +
      COALESCE(
        (SELECT cardinality(ARRAY(SELECT unnest(a.spotify_genres) INTERSECT SELECT unnest(seed_genres))) * 20),
        0
      ) +
      CASE WHEN e.category = seed_category AND v.city = seed_city THEN 30
           WHEN e.category = seed_category THEN 10
           ELSE 0 END
    )::integer AS similarity_score,
    CASE
      WHEN e.artist_id IS NOT NULL AND e.artist_id = seed_artist_id THEN 'same_artist'
      WHEN a.spotify_genres && seed_genres THEN 'shared_genres'
      WHEN e.category = seed_category AND v.city = seed_city THEN 'same_category_city'
      WHEN e.category = seed_category THEN 'same_category'
      ELSE 'unknown'
    END AS similarity_reason
  FROM events e
  LEFT JOIN artists a ON a.id = e.artist_id
  LEFT JOIN venues v ON v.id = e.venue_id
  WHERE e.id != seed_event_id
    AND e.status = 'active'
    AND e.event_date >= today_date
    AND (
      (e.artist_id IS NOT NULL AND e.artist_id = seed_artist_id) OR
      (a.spotify_genres && seed_genres) OR
      (e.category = seed_category)
    )
  ORDER BY similarity_score DESC, e.event_date ASC
  LIMIT result_limit;
END;
$$;

COMMENT ON FUNCTION public.recommend_similar_events_rpc IS
  'Multi-signal similarity scoring for event recommendations. Phase 2A-4.';
