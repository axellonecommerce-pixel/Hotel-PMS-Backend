-- Rooms to sell per room type and date (HotelKey inventory control). NULL
-- means every free rentable room can be sold.
ALTER TABLE rate_calendar ADD COLUMN IF NOT EXISTS sell_limit integer CHECK (sell_limit IS NULL OR sell_limit >= 0);
