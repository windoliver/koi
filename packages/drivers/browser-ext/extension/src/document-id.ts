export interface MainFrameDocumentInfo {
  readonly tabId: number;
  readonly documentId: string;
  readonly url: string;
  readonly origin: string;
}

interface NavigationFrameInfo {
  readonly parentFrameId?: number;
  readonly documentId?: string;
  readonly url?: string;
}

export async function getMainFrameDocument(tabId: number): Promise<MainFrameDocumentInfo | null> {
  const frames = (await (
    chrome.webNavigation.getAllFrames as unknown as (
      details: chrome.webNavigation.GetAllFrameDetails,
    ) => Promise<readonly NavigationFrameInfo[] | undefined>
  )({ tabId })) as readonly NavigationFrameInfo[] | undefined;
  const mainFrame = frames?.find((frame) => frame.parentFrameId === -1);
  if (!mainFrame?.documentId || !mainFrame.url) return null;

  let origin: string;
  try {
    origin = new URL(mainFrame.url).origin;
  } catch {
    return null;
  }

  return {
    tabId,
    documentId: mainFrame.documentId,
    url: mainFrame.url,
    origin,
  };
}
