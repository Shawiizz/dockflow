import nextra from 'nextra'

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
  }
})
