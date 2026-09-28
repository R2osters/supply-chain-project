-- Risk findings from live earthquake and wildfire feeds (hazards module). Cyclones and severe
-- weather keep using WEATHER_RISK.
ALTER TYPE "RiskCategory" ADD VALUE IF NOT EXISTS 'NATURAL_HAZARD';
