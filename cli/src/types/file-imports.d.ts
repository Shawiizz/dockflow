// A file imported `with { type: 'file' }` resolves to its path, which Bun.file()
// reads both from source and from inside a compiled binary. bun-types covers the
// common extensions; built-in plugins also ship nginx configs.
declare module '*.conf' {
  const path: string;
  export default path;
}
