import { isOriginAllowedByPolicy } from "./private-origin.js";
import type { ExtensionStorage } from "./storage.js";

export type ConsentResolution = "allow_once" | "always" | "user_denied" | "timeout";

export interface ConsentManager {
  readonly requestConsent: (request: {
    readonly tabId: number;
    readonly origin: string;
    readonly documentId: string;
    readonly timeoutMs?: number;
    readonly getCurrentDocumentId: (tabId: number) => Promise<string | null>;
  }) => Promise<ConsentResolution>;
  readonly dismissPrompt: (tabId: number) => Promise<void>;
}

interface NotificationChoice {
  readonly tabId: number;
  readonly origin: string;
  readonly documentId: string;
  readonly timeoutHandle: ReturnType<typeof setTimeout>;
  readonly resolve: (result: ConsentResolution) => void;
  readonly getCurrentDocumentId: (tabId: number) => Promise<string | null>;
}

function createNotificationOptions(origin: string): chrome.notifications.NotificationOptions<true> {
  return {
    type: "basic",
    iconUrl: "icon-128.png",
    title: "Koi wants to attach to this tab",
    message: `Allow access to ${origin}?`,
    buttons: [{ title: "Allow once" }, { title: "Always" }, { title: "Deny" }],
    priority: 2,
    requireInteraction: true,
  };
}

async function createNotification(
  notificationId: string,
  options: chrome.notifications.NotificationOptions<true>,
): Promise<string> {
  return await (
    chrome.notifications.create as unknown as (
      id: string,
      opts: chrome.notifications.NotificationOptions<true>,
    ) => Promise<string>
  )(notificationId, options);
}

async function clearNotification(notificationId: string): Promise<void> {
  await (chrome.notifications.clear as unknown as (id: string) => Promise<boolean>)(notificationId);
}

export function createConsentManager(storage: ExtensionStorage): ConsentManager {
  const pendingByNotificationId = new Map<string, NotificationChoice>();
  const notificationIdByTab = new Map<number, string>();

  const resolveChoice = async (
    notificationId: string,
    result: ConsentResolution,
    buttonIndex?: number,
  ): Promise<void> => {
    const choice = pendingByNotificationId.get(notificationId);
    if (!choice) return;
    pendingByNotificationId.delete(notificationId);
    notificationIdByTab.delete(choice.tabId);
    clearTimeout(choice.timeoutHandle);
    await clearNotification(notificationId).catch(() => undefined);

    if (result === "allow_once" || result === "always") {
      const currentDocumentId = await choice.getCurrentDocumentId(choice.tabId);
      if (currentDocumentId !== choice.documentId) {
        choice.resolve("user_denied");
        return;
      }
    }

    if (buttonIndex === 0 || result === "allow_once") {
      await storage.grantAllowOnce(choice.tabId, choice.documentId, choice.origin);
      choice.resolve("allow_once");
      return;
    }

    if (buttonIndex === 1 || result === "always") {
      const allowedByPolicy = await isOriginAllowedByPolicy(storage, choice.origin);
      if (!allowedByPolicy) {
        choice.resolve("user_denied");
        return;
      }
      await storage.setAlwaysGrant(choice.origin, new Date().toISOString());
      choice.resolve("always");
      return;
    }

    choice.resolve(result);
  };

  chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    void resolveChoice(
      notificationId,
      buttonIndex === 0 ? "allow_once" : buttonIndex === 1 ? "always" : "user_denied",
      buttonIndex,
    );
  });

  chrome.notifications.onClosed.addListener((notificationId) => {
    if (!pendingByNotificationId.has(notificationId)) return;
    void resolveChoice(notificationId, "user_denied");
  });

  return {
    async requestConsent(request): Promise<ConsentResolution> {
      const existing = notificationIdByTab.get(request.tabId);
      if (existing) await resolveChoice(existing, "user_denied");

      const notificationId = `koi-consent-${request.tabId}-${crypto.randomUUID()}`;
      const timeoutHandle = setTimeout(() => {
        void resolveChoice(notificationId, "timeout");
      }, request.timeoutMs ?? 60_000);

      const resolution = new Promise<ConsentResolution>((resolve) => {
        pendingByNotificationId.set(notificationId, {
          tabId: request.tabId,
          origin: request.origin,
          documentId: request.documentId,
          timeoutHandle,
          resolve,
          getCurrentDocumentId: request.getCurrentDocumentId,
        });
      });

      notificationIdByTab.set(request.tabId, notificationId);
      await createNotification(notificationId, createNotificationOptions(request.origin));
      return await resolution;
    },
    async dismissPrompt(tabId: number): Promise<void> {
      const notificationId = notificationIdByTab.get(tabId);
      if (!notificationId) return;
      await resolveChoice(notificationId, "user_denied");
    },
  };
}
