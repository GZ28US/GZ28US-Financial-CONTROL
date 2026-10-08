import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app is served under /ca (Control App). next/link and next/router
  // auto-apply this; raw <a>, fetch('/api/...') and <img src> are prefixed
  // manually with BASE_PATH from @/lib/utils.
  basePath: '/ca',
  // GZ28 SHOP US (independent Next app, its own Vercel project) — Next.js Multi-Zones.
  // 08/10/2026 (Márcio: «move the /shop to the root keeping 100% of the things working»): the shop's HOME is the ROOT
  // www.gz28us.com/ . Everything else of the shop stays under /shop/* (assets, /shop/api/*, the live Stripe webhook
  // /shop/api/stripe-webhook, /shop/account logins) — proxied exactly as before.
  // basePath:false keeps the sources outside /ca.
  async redirects() {
    return [
      {
        source: "/shop",
        destination: "/",
        basePath: false,
        permanent: false,
        missing: [{ type: "header", key: "rsc" }, { type: "header", key: "next-router-prefetch" }],
      },
      // Auditoria da loja (08/10/2026): a landing antiga (público, indexável, marca velha) vai para a loja na raiz;
      // /account (link «óbvio» que cliente digita) vai para a conta da loja em vez do 404 cru da Vercel.
      { source: "/ca/landing.html", destination: "/", basePath: false, permanent: false },
      { source: "/account", destination: "/shop/account", basePath: false, permanent: false },
    ];
  },
  async rewrites() {
    return [
      // robots.txt, sitemap.xml e favicon só valem na RAIZ do domínio — vêm da loja (auditoria 08/10/2026).
      { source: "/robots.txt", destination: "https://gz28shop-us.vercel.app/shop/robots.txt", basePath: false },
      { source: "/sitemap.xml", destination: "https://gz28shop-us.vercel.app/shop/sitemap.xml", basePath: false },
      { source: "/favicon.ico", destination: "https://gz28shop-us.vercel.app/shop/icon.png", basePath: false },
      { source: "/", destination: "https://gz28shop-us.vercel.app/shop", basePath: false },
      { source: "/shop", destination: "https://gz28shop-us.vercel.app/shop", basePath: false },
      { source: "/shop/:path*", destination: "https://gz28shop-us.vercel.app/shop/:path*", basePath: false },
    ];
  },
};

export default nextConfig;
