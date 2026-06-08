import { geocodeTool } from "./geocode.js";
import { planRouteTool } from "./plan-route.js";
import { getWeatherTool } from "./get-weather.js";
import { findPoisTool } from "./find-pois.js";
import { findAccommodationTool } from "./find-accommodation.js";
import { findKnooppuntenTool } from "./find-knooppunten.js";
import { webSearchTool } from "./web-search.js";

export const veloGuideTools = [
  geocodeTool,
  planRouteTool,
  getWeatherTool,
  findPoisTool,
  findAccommodationTool,
  findKnooppuntenTool,
  webSearchTool,
];
