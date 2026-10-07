import { fileURLToPath } from 'url'
import nextra from 'nextra'
import { VERSION_PLACEHOLDER, dockflowVersion } from './cli-version.mjs'

// the release the examples pin (see cli-version.mjs)
const version = await dockflowVersion()

const withNextra = nextra({
  defaultShowCopyCode: true
})

export default withNextra({
  i18n: {
    locales: ['en', 'fr'],
    defaultLocale: 'en'
  },
  async rewrites() {
    return [
      // The embedded UI demo (public/ui-demo) is a client-rendered SPA — any
      // path under it that isn't a real static asset falls back to its index.html
      // so Angular's router can take over (matches after real files, see Next docs).
      { source: '/ui-demo', destination: '/ui-demo/index.html' },
      { source: '/ui-demo/:path*', destination: '/ui-demo/index.html' }
    ]
  },
  webpack(config) {
    // before Nextra's own loader: the page and the source it offers to copy carry the version
    config.module.rules.push({
      test: /\.mdx$/,
      enforce: 'pre',
      use: [
        {
          loader: fileURLToPath(new URL('./cli-version-loader.cjs', import.meta.url)),
          options: { placeholder: VERSION_PLACEHOLDER, version }
        }
      ]
    })
    return config
  }
})
