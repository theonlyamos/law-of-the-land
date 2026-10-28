import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Law of the Land",
    short_name: "Law of the Land",
    description: "Ask legal questions in plain language and get answers grounded in published legal sources.",
    start_url: "/",
    display: "standalone",
    background_color: "#172036",
    theme_color: "#172036",
    icons: [
      { src: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/android-chrome-512x512.png", sizes: "512x512", type: "image/png" },
      { src: "/maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
