import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Loader2, Search, RefreshCw, Paperclip, ExternalLink, FileText, Plug,
  X, ArrowLeft, Reply, Forward, Send, PenLine, Pencil, Star, Archive, Trash2,
  MailOpen, Printer, Keyboard, Undo2, ShieldCheck, ShieldAlert,
  Image as ImageIcon, File as FileIcon,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ListLoading from '../components/ListLoading.jsx';
import ComposeModal from '../components/gmail/ComposeModal.jsx';
import ThreadList from '../components/gmail/ThreadList.jsx';
import AttachmentLightbox from '../components/gmail/AttachmentLightbox.jsx';
import ShortcutsSheet from '../components/gmail/ShortcutsSheet.jsx';
import { printGmailThread } from '../components/gmail/printThread.js';
import { useApp } from '../context/AppContext.jsx';
import { db, invalidate } from '../db/database.js';
import { useLiveQueryStatus } from '../db/hooks.ts';
import {
  GMAIL_BRAND_TABS, GMAIL_BRAND_OTHER, DEFAULT_GMAIL_BRAND_RULES,
  resolveGmailThreads, resolveGmailThread, resolveGmailInvoices, parseInvoiceAmount,
  resolveGmailTabCounts, resolveReplyDraft, resolveForwardDraft,
  formatGmailDate, oldestGmailAt, olderMailQuery,
} from '../core/crm/index.js';
import {
  syncGmail, syncGmailInvoices, markGmailThreadRead, markGmailThreadUnread, setGmailThreadBrand,
  setGmailThreadStarred, gmailWebUrl, expenseDeepLink,
  isPreviewable, sendGmailReply, sanitizeSignatureHtml, buildReplyContent,
  setGmailThreadInboxLocal, restoreGmailLabelsLocal, deleteGmailThreadLocal, restoreGmailMessagesLocal,
  archiveGmailThreadRemote, trashGmailThreadRemote,
} from '../lib/gmail.js';

// The invoice sender-trust gate auto-trusts DMARC-verified mail from domains the
// app already recognizes as suppliers / Ligne Roset (BEC defense); anything else
// is left to human review.
const SUPPLIER_ALLOWLIST = [
  ...(DEFAULT_GMAIL_BRAND_RULES.ligneRoset || []),
  ...(DEFAULT_GMAIL_BRAND_RULES.suppliers || []),
];

/** A compact trust badge for the Facturas list — shown only when there's a real
 *  signal (verified supplier, or a suspected spoof); silent on the default. */
function InvoiceTrustBadge({ trust }) {
  if (!trust) return null;
  if (trust.level === 'trusted') {
    return <ShieldCheck size={12} className="text-emerald-600 shrink-0" title="Remitente verificado (DMARC + proveedor conocido)" />;
  }
  if (trust.level === 'suspect') {
    return <ShieldAlert size={12} className="text-red-600 shrink-0" title={trust.reasons?.join(' ') || 'Autenticación del remitente sospechosa'} />;
  }
  return null;
}

/**
 * Gmail — the CRM email inbox. Mail is synced server-side by the google-api
 * `gmailSync` action (one connected Google account) into gmail_messages; this
 * View reads that table and renders it bucketed by CATEGORY (Ligne Roset /
 * Proveedores / Finanzas / Operaciones / Boletines / Otros) plus a FACTURAS
 * tab. All derivation — classification, invoice detection, thread roll-ups,
 * tab counts, date labels — lives in core/crm; this View fetches, holds UI
 * state (tab, search, selection, undo) and renders.
 *
 * Near-live: a visibility-aware poll (like the WhatsApp inbox) runs a light
 * `gmailSync` while the page is visible, so new mail and label changes made in
 * the Gmail app converge on their own; the Sincronizar button stays for the
 * impatient. Archive/trash are OPTIMISTIC with a Deshacer window — the local
 * mirror updates instantly, the remote Gmail call fires only after the
 * snackbar lapses, and a failure restores the mirror.
 *
 * The invoice tab links a bill to "nuevo gasto" via a navigation deep-link, not
 * a code import, so the CRM↔Accounting wall stays intact.
 */
const INVOICES_TAB = 'facturas';
const POLL_MS = 45_000;   // background freshness pull (page visible only)
const UNDO_MS = 6_000;    // how long "Deshacer" stays available

function fmtMoney(a) {
  if (!a || !(a.amount > 0)) return '';
  return `${a.currency} ${a.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function brandLabel(id) {
  return GMAIL_BRAND_TABS.find((t) => t.id === id)?.label || 'Otros';
}
function syncAgoLabel(ms) {
  if (!ms) return '';
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return 'Actualizado ahora';
  if (min < 60) return `Actualizado hace ${min} min`;
  return `Actualizado hace ${Math.floor(min / 60)} h`;
}

export default function Gmail() {
  const { profileId, settings } = useApp();
  const connected = !!settings?.googleConnectedAt;

  const { data: messages, loaded } = useLiveQueryStatus(
    () => db.gmailMessages.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  // Customers + professionals power the composer's recipient autocomplete.
  const { data: customers } = useLiveQueryStatus(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const { data: professionals } = useLiveQueryStatus(
    () => db.professionals.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );

  const [tab, setTab] = useState(GMAIL_BRAND_TABS[0].id);
  const [composeOpen, setComposeOpen] = useState(false);
  // Seed for the compose window: null for a blank "Redactar", or { subject, body }
  // when forwarding the open thread.
  const [composeInitial, setComposeInitial] = useState(null);
  const openCompose = useCallback((initial = null) => { setComposeInitial(initial); setComposeOpen(true); }, []);
  const [needle, setNeedle] = useState('');
  const [selectedThreadId, setSelectedThreadId] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Bumped by the `r` shortcut — tells the open thread's ReplyComposer to expand.
  const [replySignal, setReplySignal] = useState(0);
  const searchRef = useRef(null);
  const syncingRef = useRef(false);
  // The attachment lightbox: { messageId, attachments, index } | null. We carry
  // the whole message's attachment list (+ the opened index) so the lightbox can
  // page prev/next without closing — quick attachment navigation on a phone.
  const [preview, setPreview] = useState(null);
  const openPreview = useCallback(
    (messageId, attachments, index = 0) => setPreview({ messageId, attachments, index }),
    [],
  );

  // ── Optimistic archive/trash with an undo window ──────────────────────────
  // ONE pending action at a time: apply the local mirror change immediately,
  // hold the remote Gmail call for UNDO_MS behind a "Deshacer" snackbar, and on
  // a remote failure restore the mirror (reconcile-on-failure).
  const pendingUndo = useRef(null);
  const snackTimer = useRef(null);
  const [snack, setSnack] = useState(null); // { label, undo? } | { label, error }

  const flushUndo = useCallback(() => {
    const p = pendingUndo.current;
    if (!p) return;
    pendingUndo.current = null;
    clearTimeout(p.timer);
    setSnack(null);
    p.commit().catch(() => {
      p.revert().catch(() => {});
      setSnack({ error: true, label: 'No se pudo completar la acción; el correo fue restaurado.' });
      clearTimeout(snackTimer.current);
      snackTimer.current = setTimeout(() => setSnack(null), 4000);
    });
  }, []);

  const startUndoable = useCallback(async ({ label, apply, commit, revert }) => {
    flushUndo(); // commit any previous pending action before stacking a new one
    await apply();
    const entry = { commit, revert };
    entry.timer = setTimeout(flushUndo, UNDO_MS);
    pendingUndo.current = entry;
    clearTimeout(snackTimer.current);
    setSnack({
      label,
      undo: () => {
        if (pendingUndo.current !== entry) return;
        pendingUndo.current = null;
        clearTimeout(entry.timer);
        setSnack(null);
        revert().catch(() => {});
      },
    });
  }, [flushUndo]);

  // Leaving the page commits (never loses) a still-pending action.
  useEffect(() => () => { flushUndo(); clearTimeout(snackTimer.current); }, [flushUndo]);

  const archiveWithUndo = useCallback((items) => {
    if (!items?.length) return;
    const snapshots = items.map((m) => ({ id: m.id, labelIds: m.labelIds || [] }));
    const ids = items.map((m) => m.id);
    startUndoable({
      label: 'Conversación archivada.',
      apply: () => setGmailThreadInboxLocal(items, false),
      commit: () => archiveGmailThreadRemote(ids),
      revert: () => restoreGmailLabelsLocal(snapshots),
    });
  }, [startUndoable]);

  const trashWithUndo = useCallback((items) => {
    if (!items?.length) return;
    const rows = items.map((m) => ({ ...m }));
    const ids = items.map((m) => m.id);
    startUndoable({
      label: 'Conversación movida a la papelera.',
      apply: () => deleteGmailThreadLocal(items),
      commit: () => trashGmailThreadRemote(ids),
      revert: () => restoreGmailMessagesLocal(rows),
    });
  }, [startUndoable]);

  // ── Sync (manual + background) ────────────────────────────────────────────
  const runSync = useCallback(async ({ background = false } = {}) => {
    if (!connected || syncingRef.current) return;
    if (pendingUndo.current) {
      if (background) return; // never let a poll clobber an undoable state
      flushUndo();
    }
    syncingRef.current = true;
    if (!background) { setSyncing(true); setSyncError(''); }
    try {
      // Manual: two passes — the recent inbox/sent window (keeps threads fresh
      // AND refreshes read/star labels server-side) plus a dedicated invoice
      // pull so Facturas isn't limited to the recent window; invoices fail soft.
      // Background: one light default-window pass.
      await syncGmail(background ? { maxResults: 30 } : undefined);
      if (!background) {
        try { await syncGmailInvoices(); } catch { /* inbox already synced; invoices catch up next sync */ }
      }
      invalidate();
      setLastSyncAt(Date.now());
    } catch (e) {
      if (!background) setSyncError(e?.message || 'No se pudo sincronizar el correo.');
    } finally {
      syncingRef.current = false;
      if (!background) setSyncing(false);
    }
  }, [connected, flushUndo]);
  const runSyncRef = useRef(runSync);
  useEffect(() => { runSyncRef.current = runSync; }, [runSync]);

  // Pull once on mount when connected so the inbox isn't empty on first open.
  useEffect(() => {
    if (connected) runSyncRef.current();
  }, [connected]);

  // Near-live freshness (mirrors the WhatsApp inbox): a light background sync
  // on an interval, but ONLY while the tab is visible — a backgrounded tab
  // keeps no socket and the user sees nothing, so polling it just burns quota.
  useEffect(() => {
    if (!connected) return undefined;
    let id = null;
    const start = () => { if (id == null) id = setInterval(() => runSyncRef.current({ background: true }), POLL_MS); };
    const stop = () => { if (id != null) { clearInterval(id); id = null; } };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { runSyncRef.current({ background: true }); start(); }
      else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); stop(); };
  }, [connected]);

  // ── Derivations (all VM calls) ────────────────────────────────────────────
  const threads = useMemo(
    () => resolveGmailThreads(messages, { needle }),
    [messages, needle],
  );
  const invoices = useMemo(
    () => resolveGmailInvoices(messages, { needle, supplierAllowlist: SUPPLIER_ALLOWLIST }),
    [messages, needle],
  );
  // Per-tab counts (threads + unread) for the tab badges, and the invoice total.
  const counts = useMemo(() => resolveGmailTabCounts(messages), [messages]);
  const invoiceCount = useMemo(() => resolveGmailInvoices(messages, {}).length, [messages]);

  const tabThreads = useMemo(
    () => (tab === INVOICES_TAB ? [] : threads.filter((t) => t.brand === tab)),
    [threads, tab],
  );

  const selectedThread = useMemo(
    () => (selectedThreadId ? resolveGmailThread(messages, { threadId: selectedThreadId }) : null),
    [messages, selectedThreadId],
  );

  // Mark a thread read when it's opened.
  useEffect(() => {
    if (selectedThread?.items?.length) markGmailThreadRead(selectedThread.items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThreadId]);

  const openThread = useCallback((id) => setSelectedThreadId(id), []);
  const reassignBrand = async (brand) => {
    if (!selectedThread?.items?.length) return;
    await setGmailThreadBrand(selectedThread.items, brand === GMAIL_BRAND_OTHER ? null : brand);
  };
  // Thread-level mailbox actions (sync to Gmail). Archive/trash drop the thread
  // from the inbox, so they close the reading pane.
  const threadStarred = useMemo(
    () => (selectedThread?.items || []).some((m) => (m.labelIds || []).includes('STARRED')),
    [selectedThread],
  );
  const onToggleStar = () => selectedThread?.items?.length && setGmailThreadStarred(selectedThread.items, !threadStarred);
  const onMarkUnread = () => {
    if (!selectedThread?.items?.length) return;
    markGmailThreadUnread(selectedThread.items);
    setSelectedThreadId(null);
  };
  const onArchive = () => {
    const items = selectedThread?.items;
    if (!items?.length) return;
    setSelectedThreadId(null);
    archiveWithUndo(items);
  };
  const onTrash = () => {
    const items = selectedThread?.items;
    if (!items?.length) return;
    setSelectedThreadId(null);
    trashWithUndo(items);
  };
  const onForward = () => {
    if (selectedThread?.items?.length) openCompose(resolveForwardDraft(selectedThread));
  };
  const onPrint = () => selectedThread?.items?.length && printGmailThread(selectedThread);

  // Hover quick-actions on a list row — act on the thread without opening it.
  const onRowAction = useCallback((t, action) => {
    const items = (messages || []).filter((m) => (m.threadId || m.id) === t.threadId);
    if (!items.length) return;
    if (action === 'archive' || action === 'trash') {
      if (selectedThreadId === t.threadId) setSelectedThreadId(null);
      (action === 'archive' ? archiveWithUndo : trashWithUndo)(items);
    } else if (action === 'star') {
      setGmailThreadStarred(items, !t.starred);
    } else if (action === 'read') {
      if (t.unread) markGmailThreadRead(items);
      else markGmailThreadUnread(items);
    }
  }, [messages, selectedThreadId, archiveWithUndo, trashWithUndo]);

  // ── "Cargar más": pull mail older than the mirror's window ────────────────
  const [older, setOlder] = useState({ loading: false, exhausted: false, cursor: null });
  const loadOlder = useCallback(async () => {
    if (older.loading || syncingRef.current) return;
    setOlder((o) => ({ ...o, loading: true }));
    try {
      let cursor = older.cursor || oldestGmailAt(messages);
      let found = false;
      let exhausted = !cursor;
      // A window can list only already-mirrored ids (e.g. the invoice pull
      // reached that far back); step the cursor and retry, bounded.
      for (let attempt = 0; attempt < 4 && cursor; attempt += 1) {
        const query = olderMailQuery(cursor);
        // eslint-disable-next-line no-await-in-loop
        const res = await syncGmail({ query, maxResults: 100 });
        if ((res?.synced || 0) > 0) { found = true; break; }
        if (!(res?.scanned > 0)) { exhausted = true; break; }
        cursor -= 183 * 24 * 3600 * 1000;
      }
      invalidate();
      setOlder({ loading: false, exhausted, cursor: found ? null : cursor });
    } catch (e) {
      setOlder((o) => ({ ...o, loading: false }));
      setSyncError(e?.message || 'No se pudieron cargar correos anteriores.');
    }
  }, [older, messages]);

  // ── Keyboard shortcuts (desktop) ──────────────────────────────────────────
  // j/k next/prev · Enter open · e archive · # trash · r reply · s star ·
  // u back+unread · c compose · / search · ? sheet · Esc close. Never while
  // typing, never under an open modal (they own their keys).
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if (composeOpen || preview) return;
      if (shortcutsOpen) {
        if (e.key === '?') { e.preventDefault(); setShortcutsOpen(false); }
        return;
      }
      const list = tabThreads;
      const idx = selectedThreadId ? list.findIndex((t) => t.threadId === selectedThreadId) : -1;
      switch (e.key) {
        case 'j':
          if (list.length) { e.preventDefault(); openThread(list[Math.min(idx + 1, list.length - 1)].threadId); }
          break;
        case 'k':
          if (list.length) { e.preventDefault(); openThread(list[Math.max(idx - 1, 0)].threadId); }
          break;
        case 'Enter':
          if (!selectedThreadId && list.length) { e.preventDefault(); openThread(list[0].threadId); }
          break;
        case 'e':
          if (selectedThread?.items?.length) { e.preventDefault(); onArchive(); }
          break;
        case '#':
          if (selectedThread?.items?.length) { e.preventDefault(); onTrash(); }
          break;
        case 's':
          if (selectedThread?.items?.length) { e.preventDefault(); onToggleStar(); }
          break;
        case 'r':
          if (selectedThread?.items?.length) { e.preventDefault(); setReplySignal((s) => s + 1); }
          break;
        case 'u':
          if (selectedThreadId) { e.preventDefault(); onMarkUnread(); }
          break;
        case 'c':
          e.preventDefault(); openCompose(null);
          break;
        case '/':
          e.preventDefault(); searchRef.current?.focus();
          break;
        case '?':
          e.preventDefault(); setShortcutsOpen(true);
          break;
        case 'Escape':
          if (selectedThreadId) setSelectedThreadId(null);
          break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const lastSync = lastSyncAt || settings?.gmailSyncedAt || null;
  const actions = (
    <div className="flex items-center gap-2">
      {lastSync && !syncing ? (
        <span className="hidden lg:inline text-xs text-ink-400" title="Última sincronización">
          {syncAgoLabel(lastSync)}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => setShortcutsOpen(true)}
        className="hidden md:inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-400 hover:bg-ink-50 hover:text-ink-700"
        title="Atajos de teclado (?)"
        aria-label="Atajos de teclado"
      >
        <Keyboard size={16} />
      </button>
      <button
        type="button"
        onClick={() => runSync()}
        disabled={!connected || syncing}
        className="btn-secondary text-sm"
        title="Sincronizar"
      >
        {syncing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        <span className="hidden sm:inline">Sincronizar</span>
      </button>
      <button type="button" onClick={() => openCompose(null)} className="btn-brand text-sm">
        <Pencil size={16} /> Redactar
      </button>
    </div>
  );

  if (!connected) {
    return (
      <div>
        <PageHeader title="Gmail" subtitle="Bandeja de entrada por categoría" />
        <EmptyState
          icon={Plug}
          title="Conecta Google primero"
          description="La bandeja lee el correo de la cuenta de Google conectada. Conéctala en Integraciones para ver y clasificar los mensajes por categoría."
          action={(
            <Link to="/integraciones" className="inline-flex items-center gap-2 rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-700">
              Ir a Integraciones
            </Link>
          )}
        />
      </div>
    );
  }

  const threadOpen = !!selectedThreadId && tab !== INVOICES_TAB;
  // First paint: skeleton while the query is in flight, and also while the very
  // first sync of an empty mirror runs (an empty-state flash would lie).
  const showSkeleton = !loaded || (syncing && !(messages || []).length);
  const olderProps = {
    visible: loaded && (messages || []).length > 0 && !needle,
    loading: older.loading,
    exhausted: older.exhausted,
    onLoadMore: loadOlder,
  };

  return (
    // Viewport-locked column (mirrors the WhatsApp inbox): a flex column the
    // exact height of the area under the topbar, so the PAGE never shell-scrolls
    // — only the thread list / reading pane scroll, inside their panes. This is
    // what makes the phone experience no-scroll: tap a brand tab, scan the list,
    // open a mail and read it, all without the page itself moving. Negative
    // margins cancel the shared content-wrapper padding for an edge-to-edge pane;
    // desktop fills the content area the same way (100dvh − the md py-6 gutter).
    <div className="flex flex-col kb-inbox-pane max-md:h-[calc(var(--rs-vvh,100dvh)-55px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] max-md:-mt-4 max-md:-mb-[calc(1.5rem+env(safe-area-inset-bottom))] md:h-[calc(100dvh-3rem)]">
      {/* List-level chrome — header, tabs, search. On a phone an OPEN mail takes
          the screen over (ReadingPane carries its own Back), so this steps aside;
          desktop keeps it always-on above the split pane. */}
      <div className={threadOpen ? 'hidden md:block' : undefined}>
        <PageHeader
          title="Gmail"
          subtitle={settings?.googleEmail ? `Bandeja de ${settings.googleEmail}` : 'Bandeja de entrada por categoría'}
          actions={actions}
        />

        {syncError && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <span className="min-w-0">{syncError}</span>
            <button
              type="button"
              onClick={() => runSync()}
              disabled={syncing}
              className="shrink-0 text-xs font-semibold underline underline-offset-2 hover:text-red-800 disabled:opacity-50"
            >
              Reintentar
            </button>
          </div>
        )}

        {/* Tabs: brands + Facturas. Horizontally scrollable on a narrow phone so
            the row never wraps and steals a second line of vertical space. */}
        <div className="mb-4 flex items-center gap-1 border-b border-ink-100 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {GMAIL_BRAND_TABS.map((t) => (
            <TabButton
              key={t.id}
              active={tab === t.id}
              onClick={() => { setTab(t.id); setSelectedThreadId(null); }}
              label={t.label}
              badge={counts[t.id]?.unread || 0}
              count={counts[t.id]?.threads || 0}
            />
          ))}
          <TabButton
            active={tab === INVOICES_TAB}
            onClick={() => { setTab(INVOICES_TAB); setSelectedThreadId(null); }}
            label="Facturas"
            icon={FileText}
            count={invoiceCount}
          />
        </div>

        {/* Search */}
        <div className="mb-4 relative md:max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            ref={searchRef}
            type="search"
            value={needle}
            onChange={(e) => setNeedle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') e.currentTarget.blur(); }}
            placeholder="Buscar correo…"
            className="w-full rounded-lg border border-ink-200 bg-surface pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-300"
          />
        </div>
      </div>

      {tab === INVOICES_TAB ? (
        // The Facturas table fills the rest and scrolls inside its own box
        // (edge-to-edge on a phone) so the page shell stays put.
        <div className="flex-1 min-h-0 overflow-auto max-md:-mx-4">
          {showSkeleton ? (
            <div className="rounded-xl border border-ink-100 bg-surface overflow-hidden"><ListLoading rows={6} /></div>
          ) : (
            <InvoiceList invoices={invoices} onPreview={openPreview} />
          )}
        </div>
      ) : (
        // Master-detail card: list + reading pane side by side on desktop; on a
        // phone it's one-at-a-time (list full width, then the open mail full
        // screen). flex-1/min-h-0 lets the inner panes own the scroll.
        <div className="flex-1 min-h-0 flex overflow-hidden border-ink-100 bg-surface md:rounded-xl md:border max-md:-mx-4">
          <div className={`${threadOpen ? 'hidden md:flex' : 'flex'} w-full md:w-[24rem] shrink-0 flex-col md:border-r border-ink-100`}>
            {showSkeleton ? (
              <div className="flex-1 overflow-y-auto"><ListLoading rows={8} /></div>
            ) : (
              <ThreadList
                threads={tabThreads}
                selectedId={selectedThreadId}
                onOpen={openThread}
                brandTab={tab}
                needle={needle}
                onRowAction={onRowAction}
                older={olderProps}
              />
            )}
          </div>
          <div className={`${threadOpen ? 'flex' : 'hidden md:flex'} flex-1 min-w-0 flex-col`}>
            <ReadingPane
              thread={selectedThread}
              onReassign={reassignBrand}
              onPreview={openPreview}
              onBack={() => setSelectedThreadId(null)}
              starred={threadStarred}
              onToggleStar={onToggleStar}
              onMarkUnread={onMarkUnread}
              onArchive={onArchive}
              onTrash={onTrash}
              onForward={onForward}
              onPrint={onPrint}
              replySignal={replySignal}
              selfEmail={settings?.googleEmail || ''}
              signatureEs={settings?.gmailSignature || ''}
              signatureEn={settings?.gmailSignatureEn || ''}
              fromName={settings?.companyName || ''}
            />
          </div>
        </div>
      )}

      {preview && (
        <AttachmentLightbox
          messageId={preview.messageId}
          attachments={preview.attachments}
          index={preview.index}
          onClose={() => setPreview(null)}
        />
      )}

      {/* The undo snackbar — one at a time; text-canvas flips with the theme so
          it stays readable on the ink-900 pill in light AND dark. */}
      {snack && (
        <div className="fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom))] left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-full bg-ink-900 py-2 pl-4 pr-2 shadow-pop">
          <span className="whitespace-nowrap text-sm text-canvas">{snack.label}</span>
          {snack.undo ? (
            <button
              type="button"
              onClick={snack.undo}
              className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-semibold text-canvas underline underline-offset-2 hover:bg-canvas/10"
            >
              <Undo2 size={14} /> Deshacer
            </button>
          ) : <span className="w-2" />}
        </div>
      )}

      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        customers={customers}
        professionals={professionals}
        messages={messages}
        initial={composeInitial}
        signatureEs={settings?.gmailSignature || ''}
        signatureEn={settings?.gmailSignatureEn || ''}
        fromName={settings?.companyName || ''}
        onSent={() => setSyncError('')}
      />
    </div>
  );
}

function TabButton({ active, onClick, label, badge = 0, count = 0, icon: Icon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-3 py-2 text-sm font-medium border-b-2 -mb-px transition ${
        active ? 'border-ink-900 text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-800'
      }`}
    >
      {Icon && <Icon size={15} />}
      {label}
      {count > 0 && <span className="text-xs text-ink-400">{count}</span>}
      {badge > 0 && <span className="ml-0.5 inline-flex min-w-[1.1rem] justify-center rounded-full bg-ink-900 px-1 text-[0.65rem] font-semibold text-white">{badge}</span>}
    </button>
  );
}

/** A compact square icon button for the reading-pane action bar. */
function IconAction({ label, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="inline-flex h-8 w-8 coarse:h-10 coarse:w-10 items-center justify-center rounded-lg text-ink-500 hover:bg-ink-50 hover:text-ink-800"
    >
      {children}
    </button>
  );
}

function ReadingPane({
  thread, onReassign, onPreview, onBack, starred, onToggleStar, onMarkUnread, onArchive, onTrash, onForward,
  onPrint, replySignal, selfEmail, signatureEs, signatureEn, fromName,
}) {
  // Which earlier messages are expanded. Gmail-style: the LATEST message and any
  // still-unread inbound open; the older history collapses to one-line rows.
  // Defaults are frozen per thread (opening marks messages read — recomputing on
  // that flip would re-collapse what the reader is looking at).
  const [manual, setManual] = useState({});
  const threadId = thread?.threadId || null;
  useEffect(() => { setManual({}); }, [threadId]);
  const defaultOpen = useMemo(() => {
    const items = thread?.items || [];
    const set = new Set();
    items.forEach((m, i) => {
      if (i === items.length - 1 || (m.direction === 'in' && !m.isRead)) set.add(m.id);
    });
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  if (!thread) {
    return (
      <div className="hidden md:flex flex-1 items-center justify-center text-sm text-ink-400">
        Selecciona un correo para leerlo.
      </div>
    );
  }
  const last = thread.items[thread.items.length - 1] || null;
  const collapsible = thread.items.length > 1;
  const isOpen = (m) => !collapsible || (manual[m.id] ?? defaultOpen.has(m.id));
  return (
    <div className="flex flex-1 min-h-0 flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-ink-100 px-3 py-2.5 md:px-4 md:py-3">
        {/* Back to the list — phone only; desktop keeps the split pane. */}
        <button
          type="button"
          onClick={onBack}
          className="md:hidden -ml-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-600 hover:bg-ink-50"
          aria-label="Volver a la lista"
        >
          <ArrowLeft size={18} />
        </button>
        <h2 className="min-w-0 flex-1 font-display text-base font-semibold text-ink-900 truncate">{thread.subject}</h2>
        {/* Mailbox actions — star / forward / archive / unread / print / trash
            (sync to Gmail where applicable). */}
        <div className="flex items-center gap-0.5">
          <IconAction label={starred ? 'Quitar estrella' : 'Destacar (s)'} onClick={onToggleStar}>
            <Star size={16} className={starred ? 'fill-amber-400 text-amber-400' : ''} />
          </IconAction>
          <IconAction label="Reenviar" onClick={onForward}><Forward size={16} /></IconAction>
          <IconAction label="Archivar (e)" onClick={onArchive}><Archive size={16} /></IconAction>
          <IconAction label="Marcar no leído (u)" onClick={onMarkUnread}><MailOpen size={16} /></IconAction>
          <span className="hidden md:contents">
            <IconAction label="Imprimir" onClick={onPrint}><Printer size={16} /></IconAction>
          </span>
          <IconAction label="Mover a papelera (#)" onClick={onTrash}><Trash2 size={16} /></IconAction>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={(last?.brand) || ''}
            onChange={(e) => onReassign(e.target.value || GMAIL_BRAND_OTHER)}
            className="rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-xs text-ink-700 max-sm:hidden"
            title="Reasignar categoría"
          >
            <option value="">Categoría: auto</option>
            {GMAIL_BRAND_TABS.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          {last && (
            <a
              href={gmailWebUrl(last)}
              target="_blank"
              rel="noreferrer"
              className="hidden sm:inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
            >
              <ExternalLink size={13} /> Gmail
            </a>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {thread.items.map((m) => (
          isOpen(m) ? (
            <MessageBubble
              key={m.id}
              message={m}
              onPreview={onPreview}
              onCollapse={collapsible ? () => setManual((s) => ({ ...s, [m.id]: false })) : null}
            />
          ) : (
            <CollapsedMessage key={m.id} message={m} onExpand={() => setManual((s) => ({ ...s, [m.id]: true }))} />
          )
        ))}
      </div>
      <ReplyComposer
        key={thread.threadId}
        thread={thread}
        selfEmail={selfEmail}
        signatureEs={signatureEs}
        signatureEn={signatureEn}
        fromName={fromName}
        openSignal={replySignal}
      />
    </div>
  );
}

/**
 * The Gmail-style reply bar pinned to the bottom of the reading pane. Collapsed
 * it's a single "Responder" pill; expanded it's a compact composer (To / Asunto
 * / body) with a live, rendered signature beneath the text — like Gmail — and a
 * selector to switch Spanish / English / none. The reply is sent as a real HTML
 * email (body in Lausanne + the branded signature) and threads into the
 * conversation server-side. Keyed by threadId in the parent so it resets when
 * you switch mails. `openSignal` (the `r` shortcut) expands it imperatively.
 */
function ReplyComposer({ thread, selfEmail, signatureEs, signatureEn, fromName, openSignal = 0 }) {
  const draft = useMemo(() => resolveReplyDraft(thread, { selfEmail }), [thread, selfEmail]);
  // The configured signatures, in selector order; 'none' is always available.
  const sigOptions = useMemo(() => {
    const opts = [];
    if (signatureEs?.trim()) opts.push({ lang: 'es', label: 'Español', html: signatureEs });
    if (signatureEn?.trim()) opts.push({ lang: 'en', label: 'English', html: signatureEn });
    opts.push({ lang: 'none', label: 'Sin firma', html: '' });
    return opts;
  }, [signatureEs, signatureEn]);

  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sigLang, setSigLang] = useState(sigOptions[0].lang);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const bodyRef = useRef(null);

  const chosenSigHtml = sigOptions.find((o) => o.lang === sigLang)?.html || '';
  const sigPreview = useMemo(() => sanitizeSignatureHtml(chosenSigHtml), [chosenSigHtml]);
  // A real signature exists (something other than just "Sin firma").
  const hasSignatures = sigOptions.length > 1;

  const startReply = () => {
    setTo(draft?.to || '');
    setSubject(draft?.subject || '');
    setSigLang(sigOptions[0].lang);
    setBody('');
    setError('');
    setSent(false);
    setOpen(true);
    requestAnimationFrame(() => bodyRef.current?.focus());
  };

  // The `r` shortcut. The component remounts per thread (keyed) while the
  // signal counter lives above it, so only a CHANGE after mount opens the bar.
  const seenSignal = useRef(openSignal);
  useEffect(() => {
    if (openSignal !== seenSignal.current) {
      seenSignal.current = openSignal;
      startReply();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);

  const send = async () => {
    if (!to.trim()) { setError('Falta el destinatario.'); return; }
    setSending(true);
    setError('');
    try {
      const { html, text } = buildReplyContent({ body, signatureHtml: chosenSigHtml });
      await sendGmailReply({
        to: to.trim(),
        subject: subject.trim(),
        html,
        text,
        fromName,
        messageId: draft?.inReplyToId,
        threadId: draft?.threadId,
      });
      setSent(true);
      setOpen(false);
    } catch (e) {
      setError(e?.message || 'No se pudo enviar la respuesta.');
    } finally {
      setSending(false);
    }
  };

  if (!open) {
    return (
      <div className="shrink-0 border-t border-ink-100 px-3 py-2.5 md:px-4 flex items-center gap-3">
        <button
          type="button"
          onClick={startReply}
          className="inline-flex items-center gap-2 rounded-full border border-ink-200 bg-surface px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
        >
          <Reply size={15} /> Responder
        </button>
        {sent && <span className="text-xs font-medium text-emerald-600">Respuesta enviada ✓</span>}
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-ink-100 bg-surface px-3 py-3 md:px-4 space-y-2">
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-xs font-medium text-ink-400">Para</span>
        <input
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="destinatario@correo.com"
          className="min-w-0 flex-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ink-300"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-xs font-medium text-ink-400">Asunto</span>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ink-300"
        />
      </div>
      {/* Body + the rendered signature beneath it, inside one framed box so it
          reads like the message it'll become. */}
      <div className="rounded-lg border border-ink-200 focus-within:ring-2 focus-within:ring-ink-300">
        <textarea
          ref={bodyRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          placeholder="Escribe tu respuesta…"
          className="w-full resize-none rounded-t-lg bg-surface px-3 py-2 text-sm leading-relaxed focus:outline-none"
          style={{ fontFamily: 'Lausanne, system-ui, sans-serif' }}
        />
        {sigPreview && (
          <div className="border-t border-dashed border-ink-100 px-3 py-2.5">
            <div dangerouslySetInnerHTML={{ __html: sigPreview }} />
          </div>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {/* Action bar: primary Send + signature selector + discard. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={sending}
          className="inline-flex items-center gap-2 rounded-full bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-50"
        >
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          Enviar
        </button>
        {hasSignatures && (
          <label className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface pl-2.5 pr-1.5 py-1.5 text-xs font-medium text-ink-600">
            <PenLine size={14} className="shrink-0 text-ink-400" />
            <select
              value={sigLang}
              onChange={(e) => setSigLang(e.target.value)}
              className="bg-transparent text-xs text-ink-700 focus:outline-none"
              aria-label="Firma"
            >
              {sigOptions.map((o) => (
                <option key={o.lang} value={o.lang}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="ml-auto inline-flex items-center justify-center rounded-lg border border-ink-200 bg-surface p-2 text-ink-500 hover:bg-ink-50"
          aria-label="Descartar"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

/** A collapsed earlier message — one line of sender + snippet; click to expand. */
function CollapsedMessage({ message, onExpand }) {
  const out = message.direction === 'out';
  return (
    <button
      type="button"
      onClick={onExpand}
      title="Mostrar mensaje"
      className="block w-full rounded-lg border border-ink-100 bg-ink-50/40 px-3 py-2 text-left transition hover:bg-ink-50"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-ink-700">
          {out ? 'Tú' : (message.fromName || message.fromEmail || 'Desconocido')}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[0.65rem] text-ink-400">
          {(message.attachments || []).length > 0 && <Paperclip size={11} />}
          {formatGmailDate(message.receivedAt || message.createdAt)}
        </span>
      </span>
      <span className="mt-0.5 block truncate text-xs text-ink-400">
        {message.snippet || message.bodyText || ''}
      </span>
    </button>
  );
}

function MessageBubble({ message, onPreview, onCollapse }) {
  const out = message.direction === 'out';
  const when = message.receivedAt || message.createdAt;
  let fullWhen = '';
  if (when) { try { fullWhen = new Date(when).toLocaleString('es-DO'); } catch { fullWhen = ''; } }
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${out ? 'border-ink-100 bg-ink-50/60 ml-6' : 'border-ink-100 bg-surface mr-6'}`}>
      <div
        className={`flex items-center justify-between gap-2 mb-1 ${onCollapse ? 'cursor-pointer' : ''}`}
        onClick={onCollapse || undefined}
        title={onCollapse ? 'Ocultar mensaje' : undefined}
      >
        <span className="text-xs font-medium text-ink-700 truncate">
          {out ? 'Tú' : (message.fromName || message.fromEmail || 'Desconocido')}
        </span>
        <span className="text-[0.65rem] text-ink-400 shrink-0" title={fullWhen}>{formatGmailDate(when)}</span>
      </div>
      {message.bodyHtml ? (
        <HtmlBody html={message.bodyHtml} />
      ) : (
        <p className="font-sans text-sm text-ink-800 leading-relaxed whitespace-pre-wrap break-words">
          {(message.bodyText || message.snippet || '').slice(0, 8000)}
        </p>
      )}
      {(message.attachments || []).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {message.attachments.map((a, i) => (
            <AttachmentChip
              key={`${a.attachmentId || a.filename}-${i}`}
              attachment={a}
              onClick={() => onPreview?.(message.id, message.attachments, i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * An email's HTML body, isolated in a sandboxed iframe — NO allow-scripts, so the
 * email's own markup/CSS renders but nothing it carries can execute or reach the
 * app. `allow-same-origin` is granted only so we can measure the content and
 * auto-size the frame; `allow-popups` lets its links open in a new tab.
 */
function HtmlBody({ html }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(120);
  const srcDoc = useMemo(() => (
    `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">`
    // Load the app's Lausanne face inside the frame (the iframe shares our
    // origin, so the absolute /fonts path resolves) so mail renders in our type.
    + `<style>`
    + `@font-face{font-family:'Lausanne';src:url('/fonts/Lausanne-400.woff2') format('woff2');font-weight:400;font-display:swap}`
    + `@font-face{font-family:'Lausanne';src:url('/fonts/Lausanne-500.woff2') format('woff2');font-weight:500;font-display:swap}`
    + `@font-face{font-family:'Lausanne';src:url('/fonts/Lausanne-700.woff2') format('woff2');font-weight:700;font-display:swap}`
    + `html,body{margin:0;padding:0}`
    + `body{font-family:'Lausanne',-apple-system,'Segoe UI',sans-serif;`
    + `font-size:14px;line-height:1.6;color:#1b1b1b;word-break:break-word;overflow-wrap:anywhere;`
    + `-webkit-font-smoothing:antialiased}`
    + `img{max-width:100%;height:auto}table{max-width:100%}`
    + `a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}`
    + `blockquote{margin:0 0 0 .25rem;padding:0 0 0 .9rem;border-left:2px solid #e5e5e5;color:#6b6b6b}`
    + `p{margin:0 0 .65em}`
    + `</style></head>`
    + `<body>${html}</body></html>`
  ), [html]);
  const onLoad = () => {
    try {
      const doc = ref.current?.contentDocument;
      const h = doc ? Math.max(doc.documentElement?.scrollHeight || 0, doc.body?.scrollHeight || 0) : 0;
      if (h) setHeight(Math.min(h + 8, 1400));
    } catch { /* cross-origin guard — keep the default height */ }
  };
  return (
    <iframe
      ref={ref}
      title="Correo"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      onLoad={onLoad}
      className="w-full rounded bg-white"
      style={{ height, border: 0 }}
    />
  );
}

function AttachmentChip({ attachment, onClick }) {
  const a = attachment || {};
  const isImg = String(a.mimeType || '').toLowerCase().startsWith('image/');
  const Icon = isImg ? ImageIcon : (isPreviewable(a.mimeType) ? FileText : FileIcon);
  return (
    <button
      type="button"
      onClick={onClick}
      title={isPreviewable(a.mimeType) ? 'Previsualizar' : 'Descargar'}
      className="inline-flex items-center gap-1.5 rounded border border-ink-200 bg-ink-50 px-2 py-1 text-[0.7rem] text-ink-700 hover:bg-ink-100 transition max-w-[14rem]"
    >
      <Icon size={12} className="shrink-0 text-ink-500" />
      <span className="truncate">{a.filename || 'archivo'}</span>
    </button>
  );
}

function InvoiceList({ invoices, onPreview }) {
  if (!invoices.length) {
    return (
      <div className="rounded-xl border border-ink-100 bg-surface">
        <EmptyState icon={FileText} title="Sin facturas" description="No se detectaron correos con facturas. Sincroniza para traer correo reciente." />
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-ink-100 bg-surface overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
            <th className="px-4 py-2.5 font-medium">Remitente</th>
            <th className="px-4 py-2.5 font-medium">Asunto</th>
            <th className="px-4 py-2.5 font-medium">Marca</th>
            <th className="px-4 py-2.5 font-medium text-right">Monto</th>
            <th className="px-4 py-2.5 font-medium">Fecha</th>
            <th className="px-4 py-2.5 font-medium text-right">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {invoices.map((m) => {
            const amount = m.amount || parseInvoiceAmount(m);
            const dateMs = m.receivedAt || m.createdAt;
            const fecha = dateMs ? new Date(dateMs).toISOString().slice(0, 10) : '';
            const link = expenseDeepLink({
              proveedor: m.fromName || m.fromEmail || '',
              monto: amount?.amount || '',
              fecha,
              concepto: m.subject || '',
            });
            return (
              <tr key={m.id} className="hover:bg-ink-50/60">
                <td className="px-4 py-2.5 text-ink-700 max-w-[12rem]">
                  <span className="inline-flex items-center gap-1.5 truncate">
                    <InvoiceTrustBadge trust={m.trust} />
                    <span className="truncate">{m.fromName || m.fromEmail}</span>
                  </span>
                </td>
                <td className="px-4 py-2.5 text-ink-700 truncate max-w-[16rem]">
                  <span className="inline-flex items-center gap-1.5">
                    {(m.attachments || []).length > 0 ? (
                      <button
                        type="button"
                        onClick={() => onPreview?.(m.id, m.attachments, 0)}
                        title="Previsualizar adjunto"
                        className="text-ink-400 hover:text-ink-700"
                      >
                        <Paperclip size={12} />
                      </button>
                    ) : (m.hasAttachment && <Paperclip size={12} className="text-ink-400" />)}
                    {m.subject || '(sin asunto)'}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-ink-500">{brandLabel(m.brand)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-ink-800">{fmtMoney(amount)}</td>
                <td className="px-4 py-2.5 text-ink-500">{formatGmailDate(dateMs)}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-2">
                    <Link to={link} className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50">
                      Crear gasto
                    </Link>
                    <a href={gmailWebUrl(m)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-xs text-ink-600 hover:bg-ink-50" title="Abrir en Gmail">
                      <ExternalLink size={13} />
                    </a>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
