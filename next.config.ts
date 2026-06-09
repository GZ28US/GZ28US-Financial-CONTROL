import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app is served under /fcs (Financial Control System). next/link and
  // next/router auto-apply this; raw <a>, fetch('/api/...') and <img src> are
  // prefixed manually with BASE_PATH from @/lib/utils.
  basePath: '/fcs',
};

export default nextConfig;
