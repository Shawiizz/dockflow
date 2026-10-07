// Webpack loader for the docs' .mdx pages: writes the pinned Dockflow version in place of the
// placeholder before Nextra reads a page, so the rendered page and the source it offers to copy
// both carry it (see cli-version.mjs).
module.exports = function dockflowVersionLoader(source) {
  const { placeholder, version } = this.getOptions()
  return source.replaceAll(placeholder, version)
}
