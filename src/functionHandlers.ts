import { FunctionHandler } from "./types";

const functions: FunctionHandler[] = [
  {
    schema: {
      name: "get_weather_from_coords",
      type: "function",
      description: "Get current weather",
      parameters: {
        type: "object",
        properties: {
          latitude: { type: "number" },
          longitude: { type: "number" },
        },
        required: ["latitude", "longitude"],
      },
    },
    handler: async ({ latitude, longitude }) => {
      try {
        if (
          latitude < -90 || latitude > 90 ||
          longitude < -180 || longitude > 180
        ) {
          return JSON.stringify({ error: "Invalid coordinates" });
        }

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 3000);

        const res = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m`,
          { signal: controller.signal }
        );

        const json = await res.json();
        return JSON.stringify({
          temperature_celsius: json.current.temperature_2m,
          summary: `The current temperature is ${json.current.temperature_2m}°C.`,
        });
      } catch (err: any) {
        return JSON.stringify({ error: err.message });
      }
    },
  },
];

export default functions;
