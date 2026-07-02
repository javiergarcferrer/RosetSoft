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
  IG_WINDOW_MS,
  resolveIgConversations,
  resolveIgThread,
} from './views/igInbox.js';
export {
  GMAIL_BRAND_OTHER,
  GMAIL_BRAND_TABS,
  GMAIL_CAT_PROVEEDORES,
  GMAIL_CAT_FINANZAS,
  GMAIL_CAT_OPERACIONES,
  GMAIL_CAT_BOLETINES,
  KNOWN_GMAIL_CATEGORIES,
  DEFAULT_GMAIL_BRAND_RULES,
  senderDomain,
  classifyBrand,
  isInvoiceEmail,
  parseInvoiceAmount,
  resolveGmailThreads,
  resolveGmailThread,
  resolveGmailInvoices,
  resolveGmailTabCounts,
  resolveInvoiceTrust,
  formatGmailDate,
  senderInitials,
  avatarColorIndex,
  oldestGmailAt,
  olderMailQuery,
  resolveReplyDraft,
  replySubject,
  forwardSubject,
  resolveForwardDraft,
  isEmailAddress,
  resolveEmailRecipients,
} from './views/gmailInbox.js';
export {
  VAR_SOURCES,
  resolveBroadcastAudience,
  resolveEmailAudience,
  buildBroadcastRecipients,
  fillTemplateBody,
  fillEmailTokens,
  escapeHtml,
  normalizeGroupRows,
  resolveCampaignsList,
} from './views/campaigns.js';
export {
  resolveGroupsList,
  resolveGroupParticipants,
  resolveGroupAudience,
  buildGroupBroadcastRecipients,
} from './views/groups.js';
export { buildDraftTurns } from './views/draft.js';
export { resolveTemplateHealth } from './views/templates.js';
export { resolveWaHealth } from './views/health.js';
export { waDigits, phoneKey, displayPhone, groupKey, isGroupKey, groupIdFromKey } from '../../lib/phone.js';
