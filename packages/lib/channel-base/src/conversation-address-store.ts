/**
 * @koi/channel-base — ConversationAddressStore: durable map of
 * conversation.id -> verified outbound address (serviceUrl, tenant, etc).
 */

export type ConversationAddress = {
  readonly serviceUrl: string;
  readonly tenantId: string;
  readonly channelId: string;
  readonly recipient: { readonly id: string; readonly name?: string };
  readonly lastSeenAt: number;
};

export interface ConversationAddressStore {
  put(conversationId: string, address: ConversationAddress): Promise<void>;
  get(conversationId: string): Promise<ConversationAddress | null>;
}

export class InMemoryConversationAddressStore implements ConversationAddressStore {
  readonly #map = new Map<string, ConversationAddress>();

  async put(id: string, addr: ConversationAddress): Promise<void> {
    this.#map.set(id, addr);
  }

  async get(id: string): Promise<ConversationAddress | null> {
    return this.#map.get(id) ?? null;
  }
}
