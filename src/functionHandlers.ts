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
        const res = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m`
        );
        const json = await res.json();
        return JSON.stringify({
          temperature: json.current.temperature_2m,
        });
      } catch (err: any) {
        return JSON.stringify({ error: err.message });
      }
    },
  },
];

export default functions;
