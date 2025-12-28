import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { Banner, Head } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import { Inter } from 'next/font/google'
import 'nextra-theme-docs/style.css'

const inter = Inter({ 
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter'
})

export const metadata = {
  title: {
    template: '%s - Dockflow',
    default: 'Dockflow - Deploy with confidence'
  },
  description: 'A powerful deployment framework that simplifies Docker deployments to remote servers using Docker Swarm.',
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

const banner = (
  <Banner storageKey="dockflow-dev-warning">
    ⚠️ Dockflow is currently under development. Bugs may occur. Please report any issues on{' '}
    <a href="https://github.com/Shawiizz/dockflow/issues/new" target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
      GitHub
    </a>
    .
  </Banner>
)

const navbar = (
  <Navbar
    logo={<b>Dockflow</b>}
    projectLink="https://github.com/Shawiizz/dockflow"
  />
)

const footer = <Footer>Dockflow Documentation</Footer>

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pageMap = await getPageMap()

  return (
    <html lang="en" dir="ltr" suppressHydrationWarning className={inter.className}>
      <Head faviconGlyph="🐳" />
      <body>
        <Layout
          banner={banner}
          navbar={navbar}
          pageMap={pageMap}
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
