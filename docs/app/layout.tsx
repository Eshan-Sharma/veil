import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Head } from 'nextra/components'

export const metadata: Metadata = {
  title: {
    default: 'Veil Protocol Docs',
    template: '%s - Veil Protocol Docs',
  },
  description:
    'Developer documentation for Veil, the privacy-first cross-chain lending protocol on Solana.',
  icons: {
    icon: '/favicon.ico',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode
}>) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head />
      <body>{children}</body>
    </html>
  )
}
