-- Migration: indexes for MCP tools performance
-- Phase 1A — targets p95 < 300ms for search_events, < 200ms for get_event, < 400ms for events_near

-- search_by_artist: artist lookup via JOIN
CREATE INDEX IF NOT EXISTS idx_events_artist
  ON public.events(artist_id)
  WHERE artist_id IS NOT NULL;

-- search_events with mood_tags filter
CREATE INDEX IF NOT EXISTS idx_events_mood_tags
  ON public.events USING GIN(mood_tags);

-- find_cheapest_ticket + get_event listings join
CREATE INDEX IF NOT EXISTS idx_listings_event_avail
  ON public.listings(event_id, is_available, price_min)
  WHERE is_available = true;

-- events_near: geographic distance via ll_to_earth
CREATE INDEX IF NOT EXISTS idx_venues_geo
  ON public.venues USING GIST(ll_to_earth(latitude, longitude))
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- search_by_artist: trigram fuzzy match on artist names
CREATE INDEX IF NOT EXISTS idx_artists_name_trgm
  ON public.artists USING GIN(name gin_trgm_ops);
