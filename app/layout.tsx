import type { Metadata } from 'next'
import './globals.css'
import AuthGate from '@/components/AuthGate'

export const metadata: Metadata = {
  title: 'GZ28US Financial CONTROL',
  description: 'GZ28 V8 SpeedShop USA LLC — Financial Control',
  openGraph: {
    title: 'GZ28US Financial CONTROL',
    description: 'GZ28 V8 SpeedShop USA LLC — Financial Control',
    url: 'https://www.gz28us.com/fcs',
    siteName: 'GZ28US Financial CONTROL',
    images: [
      {
        url: 'https://www.gz28us.com/fcs/logo_gz28.jpg',
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