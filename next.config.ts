import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app is served under /ca (Control App). next/link and next/router
  // auto-apply this; raw <a>, fetch('/api/...') and <img src> are prefixed
  // manually with BASE_PATH from @/lib/utils.
  basePath: '/ca',
  // GZ28 SHOP US (independent Next app) lives at www.gz28us.com/gz28shop. It deploys
  // as its own Vercel project; we proxy that path to it here (Next.js Multi-Zones).
  // basePath:false keeps the source at /gz28shop (NOT /ca/gz28shop).
  async rewrites() {
    return [
      { source: "/gz28shop", destination: "https://gz28shop-us.vercel.app/gz28shop", basePath: false },
      { source: "/gz28shop/:path*", destination: "https://gz28shop-us.vercel.app/gz28shop/:path*", basePath: false },
    ];
  },
};

export default nextConfig;
