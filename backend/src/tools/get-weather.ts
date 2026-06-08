import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

const WEATHER_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

export const getWeatherTool: ToolDefinition = {
  name: "get_weather",
  label: "Get Weather Forecast",
  description:
    "Get weather forecast for a location and date range. Returns daily temperature, precipitation, wind speed/direction, and conditions. Forecasts are only available for the next 16 days.",
  parameters: Type.Object({
    lat: Type.Number({ description: "Latitude" }),
    lon: Type.Number({ description: "Longitude" }),
    start_date: Type.String({ description: "Start date (YYYY-MM-DD)" }),
    end_date: Type.String({ description: "End date (YYYY-MM-DD)" }),
  }),
  execute: async (_toolCallId, params: any) => {
    const today = new Date();
    const start = new Date(params.start_date);
    const maxForecast = new Date(today);
    maxForecast.setDate(maxForecast.getDate() + 16);

    if (start > maxForecast) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Weather forecasts are only available for the next 16 days (until ${maxForecast.toISOString().split("T")[0]}). The requested date ${params.start_date} is too far ahead. Plan the route and POIs now, and advise the user to check weather closer to their trip date.`,
          },
        ],
        details: {},
      };
    }

    const url = new URL(OPEN_METEO_URL);
    url.searchParams.set("latitude", String(params.lat));
    url.searchParams.set("longitude", String(params.lon));
    url.searchParams.set("start_date", params.start_date);
    url.searchParams.set("end_date", params.end_date);
    url.searchParams.set("daily", [
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "precipitation_probability_max",
      "wind_speed_10m_max",
      "wind_direction_10m_dominant",
      "weather_code",
      "sunrise",
      "sunset",
    ].join(","));
    url.searchParams.set("timezone", "Europe/Amsterdam");

    const res = await fetch(url.toString());

    if (!res.ok) {
      return {
        content: [{ type: "text" as const, text: `Weather API error: ${res.status} ${res.statusText}` }],
        details: {},
      };
    }

    const data = await res.json();
    const daily = data.daily;

    if (!daily?.time?.length) {
      return {
        content: [{ type: "text" as const, text: "No weather data available for the requested dates." }],
        details: {},
      };
    }

    const forecast = daily.time.map((date: string, i: number) => ({
      date,
      temp_max_c: daily.temperature_2m_max[i],
      temp_min_c: daily.temperature_2m_min[i],
      precipitation_mm: daily.precipitation_sum[i],
      precipitation_probability_pct: daily.precipitation_probability_max[i],
      wind_speed_max_kmh: daily.wind_speed_10m_max[i],
      wind_direction_deg: daily.wind_direction_10m_dominant[i],
      conditions: WEATHER_CODES[daily.weather_code[i]] ?? `Code ${daily.weather_code[i]}`,
      sunrise: daily.sunrise[i],
      sunset: daily.sunset[i],
    }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify(forecast, null, 2) }],
      details: {},
    };
  },
};
