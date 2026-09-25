// Which messenger a conversation belongs to, and which bridge answers for it.
// Pure and dependency-free so QML and the TypeScript share ONE definition.
// Rebuild the QML module: bun build source-id.ts --target browser --format esm --outfile SourceId.mjs

export const WHATSAPP_SERVICE = "WhatsApp";

/**
 * A WhatsApp id is a JID and always ends in one of these; an iMessage id is a
 * phone number, an email address, 32 hex characters or `chat<digits>`. Nothing
 * in either set can be read as the other, which is why the two messengers
 * share the per-chat maps in state.json without a compound key.
 */
export function isWhatsAppChat(chat: string): boolean {
  return /@(?:c\.us|g\.us|lid|s\.whatsapp\.net|broadcast)$/i.test(String(chat || ""));
}

export function isWhatsAppGroup(chat: string): boolean {
  return /@g\.us$/i.test(String(chat || ""));
}

/** Status updates are neither a conversation nor a person. */
export function isBroadcast(chat: string): boolean {
  return /@broadcast$/i.test(String(chat || ""));
}

export function sourceFor(chat: string): "imessage" | "whatsapp" {
  return isWhatsAppChat(chat) ? "whatsapp" : "imessage";
}

/**
 * A group id is "not a phone/email": `chat<digits>`, 32 hex, or a WhatsApp
 * group JID — never a positive regex on one shape (`isGroupChat` used to live
 * in collector.ts; it moved here so the person fold can share the ONE
 * definition without an import cycle).
 */
export function isGroupChat(chat: string): boolean {
  // A WhatsApp id is a JID, so it is decided by its suffix before the `@` test
  // below can mistake `…@g.us` for an email address and call a room a DM.
  if (sourceFor(chat) === "whatsapp") return isWhatsAppGroup(chat);
  if (/^\+?[0-9]{5,}$/.test(chat) || chat.indexOf("@") > 0) return false;
  return chat !== "";
}

/**
 * ⚠️ Reading a WhatsApp conversation is pushed to the phone on EVERY open,
 * whatever `push_read` says.
 *
 * That setting exists to hold back the Mac: `imsg-read` marks a conversation
 * read by opening it in Messages.app, which pulls the Mac's screen to the
 * front of whatever is on it. WhatsApp's equivalent is one HTTP call that
 * opens nothing and interrupts nobody — and a read that reaches the phone is
 * the whole reason this second source is here.
 */
export function alwaysPushesRead(chat: string): boolean {
  return sourceFor(chat) === "whatsapp";
}

export type Tool = "query" | "send" | "read";

/**
 * The argv a caller must put in FRONT of its own.
 *
 * iMessage is three programs on the Mac side; WhatsApp is one script with
 * three subcommands. Carrying the difference in the prefix means every call
 * site keeps passing exactly the arguments it passed before.
 */
export function bridgeArgv(chat: string, tool: Tool, home: string, waScript: string): string[] {
  if (sourceFor(chat) === "whatsapp") {
    return tool === "query" ? ["bun", waScript] : ["bun", waScript, tool];
  }
  const bin = tool === "query" ? "imsg" : tool === "send" ? "imsg-send" : "imsg-read";
  return [`${home}/bin/${bin}`];
}
