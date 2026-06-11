import type { Metadata } from 'next'
import './globals.css'
import AuthGate from '@/components/AuthGate'

export const metadata: Metadata = {
  title: 'GZ28US Control App',
  description: 'GZ28 V8 SpeedShop USA LLC — Control App',
  openGraph: {
    title: 'GZ28US Control App',
    description: 'GZ28 V8 SpeedShop USA LLC — Control App',
    url: 'https://www.gz28us.com/ca',
    siteName: 'GZ28US Control App',
    images: [
      {
        url: 'https://www.gz28us.com/ca/logo_gz28.jpg',
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
      <body><AuthGate>{children}</AuthGate></body>
    </html>
  )
}