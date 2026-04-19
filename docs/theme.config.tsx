import { DocsThemeConfig, useConfig } from 'nextra-theme-docs'
import { useRouter } from 'next/router'

const config: DocsThemeConfig = {
  logo: (
    <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <span style={{
        display: 'grid', placeItems: 'center',
        width: 26, height: 26, borderRadius: 7,
        background: 'linear-gradient(135deg,#6d28d9,#db2777)',
      }}>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round">
          <path d="M4 5c4 6 12 6 16 0" />
          <path d="M4 12c4 6 12 6 16 0" opacity=".55" />
          <path d="M4 19c4 6 12 6 16 0" opacity=".28" />
        </svg>
      </span>
      <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: '-0.02em' }}>
        Veil Protocol
      </span>
    </span>
  ),

  project: {
    link: 'https://github.com/Eshan-Sharma/veil',
  },

  docsRepositoryBase: 'https://github.com/Eshan-Sharma/veil/tree/main/docs',

  head: () => {
    const { asPath } = useRouter()
    const { frontMatter } = useConfig()
    return (
      <>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta property="og:title" content={frontMatter.title ?? 'Veil Protocol Docs'} />
        <meta property="og:description" content={frontMatter.description ?? 'Developer documentation for Veil — the privacy-first, cross-chain lending protocol on Solana.'} />
        <link rel="icon" href="/favicon.ico" />
      </>
    )
  },

  primaryHue: { dark: 270, light: 270 },
  primarySaturation: { dark: 70, light: 60 },

  sidebar: {
    titleComponent({ title, type }) {
      if (type === 'separator') {
        return <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.5 }}>{title}</span>
      }
      return <>{title}</>
    },
    defaultMenuCollapseLevel: 1,
    toggleButton: true,
  },

  toc: {
    backToTop: true,
  },

  footer: {
    text: (
      <span style={{ fontSize: 13 }}>
        © {new Date().getFullYear()} Veil Protocol — Built on{' '}
        <a href="https://solana.com" target="_blank" rel="noopener noreferrer" style={{ color: '#6d28d9' }}>
          Solana
        </a>
        {' '}with{' '}
        <a href="https://github.com/febo/pinocchio" target="_blank" rel="noopener noreferrer" style={{ color: '#6d28d9' }}>
          Pinocchio
        </a>
      </span>
    ),
  },

  editLink: {
    text: 'Edit this page on GitHub →',
  },

  feedback: {
    content: 'Question? Open an issue →',
    labels: 'documentation',
  },

  useNextSeoProps() {
    const { asPath } = useRouter()
    if (asPath !== '/') {
      return { titleTemplate: '%s – Veil Protocol Docs' }
    }
    return { title: 'Veil Protocol Developer Documentation' }
  },
}

export default config
