/**
 * BrowserPage — page-level wrapper for the Nexus namespace browser.
 *
 * Bidirectional sync between URL ?view= param and view store.
 * Supports back/forward navigation and manual URL edits.
 */

import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { BrowserShell } from "../components/browser/browser-shell.js";
import { useViewStore } from "../stores/view-store.js";

export function BrowserPage(): React.ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeViewId = useViewStore((s) => s.activeViewId);
  const setActiveView = useViewStore((s) => s.setActiveView);

  // Ref to track changes originating from URL (prevents sync loops)
  const syncingFromUrl = useRef(false);

  // URL → store: runs on mount, back/forward, and manual URL edits
  useEffect(() => {
    const viewParam = searchParams.get("view");
    if (viewParam !== null && viewParam !== activeViewId) {
      syncingFromUrl.current = true;
      setActiveView(viewParam);
    }
  }, [searchParams, activeViewId, setActiveView]);

  // Store → URL: only for user-initiated store changes (tab clicks)
  useEffect(() => {
    if (syncingFromUrl.current) {
      syncingFromUrl.current = false;
      return;
    }
    setSearchParams({ view: activeViewId }, { replace: true });
  }, [activeViewId, setSearchParams]);

  return <BrowserShell />;
}
