/**
 * @koi/channel-base — ConversationAddressStore: durable map of
 * conversation.id -> verified outbound address (serviceUrl, tenant, etc).
 */

export type ConversationAddress = {
  readonly serviceUrl: string;
  readonly tenantId: string;
  readonly channelId: string;
  /**
   * The provider's raw conversation id (Bot Framework `conversation.id`).
   * Required because the store is keyed by a composite routing tuple, but
   * outbound activity URLs need the raw id. NOT a unique identity.
   */
  readonly conversationId: string;
  readonly recipient: { readonly id: string; readonly name?: string };
  readonly lastSeenAt: number;
};

export interface ConversationAddressStore {
  /**
   * `addressKey` should be a composite routing tuple
   * (e.g., `${channelId}|${tenantId}|${conversation.id}`), NOT the raw
   * provider conversation id. Bot Framework conversation ids are not
   * globally unique across tenants/channels.
   */
  put(addressKey: string, address: ConversationAddress): Promise<void>;
  get(addressKey: string): Promise<ConversationAddress | null>;
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
