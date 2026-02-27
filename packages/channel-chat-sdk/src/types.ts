/**
 * Internal shared types for @koi/channel-chat-sdk.
 *
 * ChatSdkEvent wraps the Thread + Message pair delivered by
 * the Chat SDK's onNewMention / onSubscribedMessage handlers.
 * This is the event type E for createChannelAdapter<E>().
 */

import type { Message, Thread } from "chat";

export interface ChatSdkEvent {
  readonly thread: Thread;
  readonly message: Message;
  readonly adapterName: string;
}
