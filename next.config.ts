import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app is served under /ca (Control App). next/link and next/router
  // auto-apply this; raw <a>, fetch('/api/...') and <img src> are prefixed
  // manually with BASE_PATH from @/lib/utils.
  basePath: '/ca',
  // GZ28 SHOP US (independent Next app) lives at www.gz28us.com/shop. It deploys
  // as its own Vercel project; we proxy that path to it here (Next.js Multi-Zones).
  // basePath:false keeps the source at /shop (NOT /ca/shop).
  async rewrites() {
    return [
      { source: "/shop", destination: "https://gz28shop-us.vercel.app/shop", basePath: false },
      { source: "/shop/:path*", destination: "https://gz28shop-us.vercel.app/shop/:path*", basePath: false },
    ];
  },
};

export default nextConfig;
