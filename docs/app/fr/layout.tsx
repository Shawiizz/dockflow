import { Footer } from 'nextra-theme-docs'
import { Banner } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import { DocsLayout } from '../_components/docs-layout'

export const metadata = {
  title: {
    template: '%s - Dockflow',
    default: 'Dockflow - Déployez en toute confiance'
  },
  description: "Un framework de déploiement puissant qui simplifie le déploiement d'applications Docker sur des serveurs distants avec Docker Swarm.",
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
    ⚠️ Dockflow est actuellement en développement. Des bugs peuvent survenir. Merci de signaler tout problème sur{' '}
    <a href="https://github.com/Shawiizz/dockflow/issues/new" target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
      GitHub
    </a>
    .
  </Banner>
)

const footer = <Footer>Dockflow &mdash; Déployez en toute confiance.</Footer>

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pageMap = await getPageMap('/fr')

  return (
    <DocsLayout lang="fr" pageMap={pageMap} banner={banner} footer={footer}>
      {children}
    </DocsLayout>
  )
}
