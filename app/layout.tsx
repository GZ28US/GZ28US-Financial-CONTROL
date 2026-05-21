import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'GZ28US Financial CONTROL',
  description: 'GZ28 V8 SpeedShop USA LLC — Financial Control',
  openGraph: {
    title: 'GZ28US Financial CONTROL',
    description: 'GZ28 V8 SpeedShop USA LLC — Financial Control',
    url: 'https://gz28-speedshop-control.vercel.app',
    siteName: 'GZ28US Financial CONTROL',
    images: [
      {
        url: 'https://gz28-speedshop-control.vercel.app/logo_gz28.jpg',
        width: 1200,
        height: 630,
        alt: 'GZ28 V8 SpeedShop',
      },
    ],
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}