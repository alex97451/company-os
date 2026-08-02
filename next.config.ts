import type { NextConfig } from "next";

const securityHeaders = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" }
];

function localDevOrigins(): string[] {
  const configured = process.env.OPS_LAN_ORIGIN?.trim();
  if (!configured) return [];
  try {
    return [new URL(configured).hostname];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  allowedDevOrigins: localDevOrigins(),
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb"
    }
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  }
};

export default nextConfig;
