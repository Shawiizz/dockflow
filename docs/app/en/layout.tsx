import { Footer } from 'nextra-theme-docs'
import { Banner } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import { DocsLayout } from '../_components/docs-layout'

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

const footer = <Footer>Dockflow &mdash; Deploy with confidence.</Footer>

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pageMap = await getPageMap('/en')

  return (
    <DocsLayout lang="en" pageMap={pageMap} banner={banner} footer={footer}>
      {children}
    </DocsLayout>
  )
}
