/** CSS Modules type shim for the client bundle. */

declare module '*.module.css' {
  /** Local class name -> prefixed class name map. */
  const classes: Record<string, string>
  export default classes
}
