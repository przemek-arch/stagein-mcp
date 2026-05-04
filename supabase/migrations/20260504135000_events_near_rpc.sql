-- Migration: RPC function for geographic event search
-- Phase 2A-3 — used by events_near tool
-- Uses earthdistance + GIST index on venues (idx_venues_geo from Phase 1A)

CREATE OR REPLACE FUNCTION public.events_near_rpc(
  center_lat double precision,
  center_lng double precision,
  radius_m double precision,
  result_limit integer DEFAULT 20,
  today_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  event_id uuid,
  title text,
  event_date date,
  category text,
  price_min numeric,
  slug text,
  venue_id uuid,
  venue_name text,
  venue_city text,
  latitude double precision,
  longitude double precision,
  distance_m double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    e.id,
    e.title,
    e.event_date,
    e.category,
    e.price_min,
    e.slug,
    v.id,
    v.name,
    v.city,
    v.latitude,
    v.longitude,
    earth_distance(
      ll_to_earth(center_lat, center_lng),
      ll_to_earth(v.latitude, v.longitude)
    ) AS distance_m
  FROM events e
  JOIN venues v ON v.id = e.venue_id
  WHERE e.status = 'active'
    AND e.event_date >= today_date
    AND v.latitude IS NOT NULL
    AND v.longitude IS NOT NULL
    AND earth_box(ll_to_earth(center_lat, center_lng), radius_m) @> ll_to_earth(v.latitude, v.longitude)
    AND earth_distance(
      ll_to_earth(center_lat, center_lng),
      ll_to_earth(v.latitude, v.longitude)
    ) <= radius_m
  ORDER BY distance_m ASC
  LIMIT result_limit;
$$;

COMMENT ON FUNCTION public.events_near_rpc IS
  'Geographic radius search for upcoming events. Uses earthdistance + GIST index on venues. Phase 2A-3.';
