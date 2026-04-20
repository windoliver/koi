type Listener<TArgs extends unknown[]> = (...args: TArgs) => void;

interface EventStub<TArgs extends unknown[]> {
  readonly addListener: (listener: Listener<TArgs>) => void;
  readonly removeListener: (listener: Listener<TArgs>) => void;
  readonly emit: (...args: TArgs) => void;
}

function createEventStub<TArgs extends unknown[]>(): EventStub<TArgs> {
  const listeners = new Set<Listener<TArgs>>();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (...args) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

export interface MockPort {
  readonly name: string;
  readonly postMessageCalls: unknown[];
  readonly onMessage: EventStub<[unknown]>;
  readonly onDisconnect: EventStub<[]>;
  readonly postMessage: (message: unknown) => void;
  readonly disconnect: () => void;
}

export interface ChromeStubController {
  readonly localState: Record<string, unknown>;
  readonly sessionState: Record<string, unknown>;
  readonly framesByTab: Map<
    number,
    readonly {
      readonly parentFrameId: number;
      readonly documentId?: string;
      readonly url?: string;
    }[]
  >;
  readonly notifications: { readonly created: string[] };
  readonly debuggerState: {
    readonly attachedTabs: Set<number>;
    attachImpl: (tabId: number) => Promise<void>;
    detachImpl: (tabId: number) => Promise<void>;
    sendCommandImpl: (tabId: number, method: string, params?: unknown) => Promise<unknown>;
    getTargetsImpl: () => Promise<
      readonly { readonly tabId?: number; readonly attached?: boolean }[]
    >;
  };
  readonly runtime: {
    connectNativeImpl: () => MockPort;
  };
  readonly emitNotificationButton: (notificationId: string, buttonIndex: number) => void;
  readonly emitAlarm: (name: string) => void;
  readonly emitCommittedNavigation: (
    details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
  ) => void;
  readonly emitTabRemoved: (tabId: number) => void;
  readonly emitDebuggerEvent: (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ) => void;
  readonly emitDebuggerDetach: (source: chrome.debugger.Debuggee, reason: string) => void;
}

export function installChromeStub(): ChromeStubController {
  const localState: Record<string, unknown> = {};
  const sessionState: Record<string, unknown> = {};
  const framesByTab = new Map<
    number,
    readonly {
      readonly parentFrameId: number;
      readonly documentId?: string;
      readonly url?: string;
    }[]
  >();

  const notificationButtonClicked = createEventStub<[string, number]>();
  const notificationClosed = createEventStub<[string]>();
  const alarmEvent = createEventStub<[chrome.alarms.Alarm]>();
  const committedEvent =
    createEventStub<[chrome.webNavigation.WebNavigationTransitionCallbackDetails]>();
  const tabRemovedEvent = createEventStub<[number]>();
  const debuggerEvent = createEventStub<[chrome.debugger.Debuggee, string, object | undefined]>();
  const debuggerDetach = createEventStub<[chrome.debugger.Debuggee, string]>();

  const notificationsCreated: string[] = [];

  const debuggerState: ChromeStubController["debuggerState"] = {
    attachedTabs: new Set<number>(),
    attachImpl: async (tabId: number): Promise<void> => {
      debuggerState.attachedTabs.add(tabId);
    },
    detachImpl: async (tabId: number): Promise<void> => {
      debuggerState.attachedTabs.delete(tabId);
    },
    sendCommandImpl: async (): Promise<unknown> => ({}),
    getTargetsImpl: async (): Promise<
      readonly { readonly tabId?: number; readonly attached?: boolean }[]
    > => [...debuggerState.attachedTabs].map((tabId) => ({ tabId, attached: true })),
  };

  const runtime = {
    connectNativeImpl: (): MockPort => createMockPort("com.koi.browser_ext"),
  };

  const chromeStub = {
    storage: {
      local: createStorageArea(localState),
      session: createStorageArea(sessionState),
    },
    runtime: {
      id: "test-extension-id",
      connectNative: () => runtime.connectNativeImpl(),
      onInstalled: createEventStub<[]>(),
    },
    notifications: {
      create: async (notificationId: string) => {
        notificationsCreated.push(notificationId);
        return notificationId;
      },
      clear: async (notificationId: string) => {
        notificationClosed.emit(notificationId);
        return true;
      },
      onButtonClicked: notificationButtonClicked,
      onClosed: notificationClosed,
    },
    alarms: {
      create: async () => undefined,
      onAlarm: alarmEvent,
    },
    webNavigation: {
      getAllFrames: async ({ tabId }: { readonly tabId: number }) => framesByTab.get(tabId),
      onCommitted: committedEvent,
    },
    tabs: {
      query: async () => [],
      onRemoved: tabRemovedEvent,
    },
    debugger: {
      attach: async ({ tabId }: chrome.debugger.Debuggee) => {
        if (tabId === undefined) throw new Error("missing tabId");
        await debuggerState.attachImpl(tabId);
      },
      detach: async ({ tabId }: chrome.debugger.Debuggee) => {
        if (tabId === undefined) throw new Error("missing tabId");
        await debuggerState.detachImpl(tabId);
      },
      sendCommand: async ({ tabId }: chrome.debugger.Debuggee, method: string, params?: object) => {
        if (tabId === undefined) throw new Error("missing tabId");
        return await debuggerState.sendCommandImpl(tabId, method, params);
      },
      getTargets: async () => await debuggerState.getTargetsImpl(),
      onEvent: debuggerEvent,
      onDetach: debuggerDetach,
    },
  };

  (globalThis as { chrome?: unknown }).chrome = chromeStub;

  return {
    localState,
    sessionState,
    framesByTab,
    notifications: { created: notificationsCreated },
    debuggerState,
    runtime,
    emitNotificationButton: (notificationId, buttonIndex) =>
      notificationButtonClicked.emit(notificationId, buttonIndex),
    emitAlarm: (name) => alarmEvent.emit({ name, scheduledTime: Date.now() }),
    emitCommittedNavigation: (details) => committedEvent.emit(details),
    emitTabRemoved: (tabId) => tabRemovedEvent.emit(tabId),
    emitDebuggerEvent: (source, method, params) => debuggerEvent.emit(source, method, params),
    emitDebuggerDetach: (source, reason) => debuggerDetach.emit(source, reason),
  };
}

function createStorageArea(state: Record<string, unknown>): chrome.storage.StorageArea {
  return {
    async get(
      keys?: string | string[] | Record<string, unknown> | null,
    ): Promise<Record<string, unknown>> {
      if (keys == null) return { ...state };
      const keyList = Array.isArray(keys)
        ? keys
        : typeof keys === "string"
          ? [keys]
          : Object.keys(keys);
      return Object.fromEntries(keyList.map((key) => [key, state[key]]));
    },
    async set(items: Record<string, unknown>): Promise<void> {
      Object.assign(state, items);
    },
  } as chrome.storage.StorageArea;
}

export function createMockPort(name: string): MockPort {
  const onMessage = createEventStub<[unknown]>();
  const onDisconnect = createEventStub<[]>();
  const postMessageCalls: unknown[] = [];
  return {
    name,
    postMessageCalls,
    onMessage,
    onDisconnect,
    postMessage(message): void {
      postMessageCalls.push(message);
    },
    disconnect(): void {
      onDisconnect.emit();
    },
  };
}
