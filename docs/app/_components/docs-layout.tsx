import { Footer, Layout as NextraLayout, Navbar } from 'nextra-theme-docs'
import { Head } from 'nextra/components'
import type { PageMapItem } from 'nextra'
import { Inter } from 'next/font/google'
import { NavbarCTA } from './navbar-cta'
import 'nextra-theme-docs/style.css'
import '../globals.css'

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter'
})

const i18n = [
  { locale: 'en', name: 'English' },
  { locale: 'fr', name: 'Français' }
]

const LOCALES = new Set(i18n.map((l) => l.locale))

/**
 * `getPageMap(route)` can return the full tree (both locale folders) instead of
 * the requested locale's subtree when no `contentDir` is configured. Descend
 * into the matching locale folder ourselves so the sidebar only shows one language.
 */
function scopeToLocale(pageMap: PageMapItem[], lang: string): PageMapItem[] {
  const isMergedRoot = pageMap.every((item) => 'name' in item && LOCALES.has(item.name))
  if (!isMergedRoot) return pageMap
  const folder = pageMap.find((item) => 'name' in item && item.name === lang)
  return folder && 'children' in folder ? (folder.children as PageMapItem[]) : pageMap
}

interface DocsLayoutProps {
  lang: 'en' | 'fr'
  pageMap: PageMapItem[]
  banner: React.ReactNode
  footer: React.ReactNode
  children: React.ReactNode
}

export function DocsLayout({ lang, pageMap: rawPageMap, banner, footer, children }: DocsLayoutProps) {
  const pageMap = scopeToLocale(rawPageMap, lang)
  const navbar = (
    <Navbar
      logo={
        <>
          <img src="/logo.svg" alt="Dockflow" style={{ height: 24 }} />
          <b style={{ marginLeft: 8 }}>Dockflow</b>
        </>
      }
      projectLink="https://github.com/Shawiizz/dockflow"
    >
      <NavbarCTA lang={lang} />
    </Navbar>
  )

  return (
    <html lang={lang} dir="ltr" suppressHydrationWarning className={inter.className}>
      <Head>
        <link rel="icon" href="/logo.svg" type="image/svg+xml" />
      </Head>
      <body>
        <NextraLayout
          banner={banner}
          navbar={navbar}
          pageMap={pageMap}
          docsRepositoryBase="https://github.com/Shawiizz/dockflow/tree/main/docs"
          footer={footer}
          sidebar={{ defaultMenuCollapseLevel: 1 }}
          i18n={i18n}
        >
          {children}
        </NextraLayout>
      </body>
    </html>
  )
}
