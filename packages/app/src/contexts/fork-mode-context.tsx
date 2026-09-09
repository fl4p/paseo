import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ForkMode } from "@/hooks/fork-mode";

/**
 * Which fork mode each target would use for the agent currently on screen.
 *
 * The fork menu lives deep inside the stream (turn footer -> assistant footer),
 * far from where the agent's provider, cwd and host features are known. Rather
 * than thread a flag through every memoized footer component, the agent view
 * publishes the resolved modes here and the menu reads them.
 *
 * The default is `attachment` for both targets: a menu rendered outside a
 * provider must not promise context preservation it cannot deliver.
 */
export interface ForkModeByTarget {
  tab: ForkMode;
  workspace: ForkMode;
}

const DEFAULT_FORK_MODES: ForkModeByTarget = { tab: "attachment", workspace: "attachment" };

const ForkModeContext = createContext<ForkModeByTarget>(DEFAULT_FORK_MODES);

export function ForkModeProvider({
  tab,
  workspace,
  children,
}: ForkModeByTarget & { children: ReactNode }) {
  const value = useMemo<ForkModeByTarget>(() => ({ tab, workspace }), [tab, workspace]);
  return <ForkModeContext.Provider value={value}>{children}</ForkModeContext.Provider>;
}

export function useForkModes(): ForkModeByTarget {
  return useContext(ForkModeContext);
}
