import type { ReactNode } from 'react'
import { Head, Search } from 'nextra/components'
import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { getPageMap } from 'nextra/page-map'
import 'nextra-theme-docs/style.css'

const logo = (
  <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
    <span
      style={{
        display: 'grid',
        placeItems: 'center',
        width: 26,
        height: 26,
        borderRadius: 7,
        background: 'linear-gradient(135deg,#6d28d9,#db2777)',
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="13"
        height="13"
        fill="none"
        stroke="white"
        strokeWidth="2.2"
        strokeLinecap="round"
      >
        <path d="M4 5c4 6 12 6 16 0" />
        <path d="M4 12c4 6 12 6 16 0" opacity=".55" />
        <path d="M4 19c4 6 12 6 16 0" opacity=".28" />
      </svg>
    </span>
    <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: '-0.02em' }}>
      Veil Protocol
    </span>
  </span>
)

const navbar = <Navbar logo={logo} projectLink="https://github.com/Eshan-Sharma/veil" />

const footer = (
  <Footer>
    <span style={{ fontSize: 13 }}>
      © {new Date().getFullYear()} Veil Protocol - Built on{' '}
      <a href="https://solana.com" target="_blank" rel="noopener noreferrer">
        Solana
      </a>{' '}
      with{' '}
      <a
        href="https://github.com/febo/pinocchio"
        target="_blank"
        rel="noopener noreferrer"
      >
        Pinocchio
      </a>
    </span>
  </Footer>
)

export default async function DocsLayout({
  children,
}: Readonly<{
  children: ReactNode
}>) {
  const pageMap = await getPageMap()

  return (
    <>
      <Head />
      <Layout
        navbar={navbar}
        search={<Search />}
        pageMap={pageMap}
        docsRepositoryBase="https://github.com/Eshan-Sharma/veil/tree/main/docs/app"
        footer={footer}
        editLink="Edit this page on GitHub ->"
        feedback={{
          content: 'Question? Open an issue ->',
          labels: 'documentation',
        }}
        sidebar={{
          defaultMenuCollapseLevel: 1,
          toggleButton: true,
        }}
        toc={{
          backToTop: true,
        }}
        navigation
      >
        {children}
      </Layout>
    </>
  )
}
