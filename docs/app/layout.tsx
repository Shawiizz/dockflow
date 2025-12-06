import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { Banner, Head } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import 'nextra-theme-docs/style.css'

export const metadata = {
  title: {
    template: '%s - Dockflow',
    default: 'Dockflow Documentation'
  },
  description: 'Documentation for Dockflow',
  applicationName: 'Dockflow',
  generator: 'Next.js',
  appleWebApp: {
    title: 'Dockflow'
  },
  other: {
    'msapplication-TileColor': '#fff'
  },
  twitter: {
    site: 'https://dockflow.org'
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const navbar = (
    <Navbar
      logo={<b>Dockflow</b>}
      projectLink="https://github.com/Shawiizz/dockflow"
    />
  )
  const footer = <Footer>Dockflow Documentation</Footer>

  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head faviconGlyph="🐳" />
      <body>
        <Banner storageKey="dockflow-dev-warning">
          ⚠️ Dockflow is currently under development. Bugs may occur. Please report any issues on{' '}
          <a href="https://github.com/Shawiizz/dockflow/issues/new" target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
            GitHub
          </a>
          .
        </Banner>
        <Layout
          navbar={navbar}
          pageMap={await getPageMap()}
          docsRepositoryBase="https://github.com/Shawiizz/dockflow/tree/main/docs"
          footer={footer}
          sidebar={{ defaultMenuCollapseLevel: 1 }}
        >
          {children}
        </Layout>
      </body>
    </html>
  )
}
