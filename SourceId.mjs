// source-id.ts
var WHATSAPP_SERVICE = "WhatsApp";
function isWhatsAppChat(chat) {
  return /@(?:c\.us|g\.us|lid|s\.whatsapp\.net|broadcast)$/i.test(String(chat || ""));
}
function isWhatsAppGroup(chat) {
  return /@g\.us$/i.test(String(chat || ""));
}
function isBroadcast(chat) {
  return /@broadcast$/i.test(String(chat || ""));
}
function sourceFor(chat) {
  return isWhatsAppChat(chat) ? "whatsapp" : "imessage";
}
function alwaysPushesRead(chat) {
  return sourceFor(chat) === "whatsapp";
}
function bridgeArgv(chat, tool, home, waScript) {
  if (sourceFor(chat) === "whatsapp") {
    return tool === "query" ? ["bun", waScript] : ["bun", waScript, tool];
  }
  const bin = tool === "query" ? "imsg" : tool === "send" ? "imsg-send" : "imsg-read";
  return [`${home}/bin/${bin}`];
}
export {
  WHATSAPP_SERVICE,
  alwaysPushesRead,
  bridgeArgv,
  isBroadcast,
  isWhatsAppChat,
  isWhatsAppGroup,
  sourceFor
};
