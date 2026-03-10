/**
 * BrowserPage — page-level wrapper for the Nexus namespace browser.
 *
 * Reads the initial view from URL query params and syncs changes back.
 */

import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { BrowserShell } from "../components/browser/browser-shell.js";
import { useViewStore } from "../stores/view-store.js";

export function BrowserPage(): React.ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeViewId = useViewStore((s) => s.activeViewId);
  const setActiveView = useViewStore((s) => s.setActiveView);

  // Sync URL → store on mount
  useEffect(() => {
    const viewParam = searchParams.get("view");
    if (viewParam !== null && viewParam !== activeViewId) {
      setActiveView(viewParam);
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync store → URL on view change
  useEffect(() => {
    const currentView = searchParams.get("view");
    if (currentView !== activeViewId) {
      setSearchParams({ view: activeViewId }, { replace: true });
    }
  }, [activeViewId, searchParams, setSearchParams]);

  return <BrowserShell />;
}
