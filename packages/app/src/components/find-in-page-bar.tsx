/**
 * Find-in-page is the desktop shell's own search over whatever the window is
 * showing. Browsers already give Cmd/Ctrl+F their native find bar, and native
 * apps have no page to search, so only the Electron build renders one.
 */
export function FindInPageBar(): null {
  return null;
}
