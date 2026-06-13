// CRM core barrel — the conversations (WhatsApp inbox) Model/ViewModels.
// Sits beside core/quote / core/tracking / core/store on the CRM side of the
// CRM↔Accounting barrier (enforced in tests/architecture.test.js).

export {
  WA_WINDOW_MS,
  resolveConversations,
  resolveThread,
  resolveNewChatContacts,
  resolveChatTarget,
  resolveReferral,
  resolveOrderMessage,
  buildOrderRefsParam,
  parseOrderRefs,
  fillQuickReply,
} from './views/inbox.js';
export {
  VAR_SOURCES,
  resolveBroadcastAudience,
  buildBroadcastRecipients,
  fillTemplateBody,
  resolveCampaignsList,
} from './views/campaigns.js';
export { buildDraftTurns } from './views/draft.js';
export { waDigits, phoneKey, displayPhone } from '../../lib/phone.js';
