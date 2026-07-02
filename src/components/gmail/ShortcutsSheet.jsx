import Modal from '../Modal.jsx';

// The desktop keyboard map the Gmail page binds (see Gmail.jsx). Kept as data
// so the sheet and any future help surface render the same list.
const GROUPS = [
  {
    title: 'Navegación',
    keys: [
      ['j', 'Siguiente conversación'],
      ['k', 'Conversación anterior'],
      ['Enter', 'Abrir la primera conversación'],
      ['u / Esc', 'Volver a la lista'],
      ['/', 'Buscar'],
    ],
  },
  {
    title: 'Acciones',
    keys: [
      ['c', 'Redactar'],
      ['r', 'Responder'],
      ['e', 'Archivar'],
      ['#', 'Mover a papelera'],
      ['s', 'Destacar / quitar estrella'],
      ['u', 'Marcar como no leído'],
    ],
  },
];

function Key({ children }) {
  return (
    <kbd className="inline-flex min-w-[1.6rem] items-center justify-center rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 font-sans text-[0.7rem] font-semibold text-ink-700 shadow-[inset_0_-1px_0_rgb(var(--ink-200))]">
      {children}
    </kbd>
  );
}

/** The "?" cheat-sheet — every keyboard shortcut the inbox understands. */
export default function ShortcutsSheet({ open, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title="Atajos de teclado" size="sm">
      <div className="space-y-5">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{g.title}</h3>
            <ul className="space-y-1.5">
              {g.keys.map(([k, label]) => (
                <li key={k} className="flex items-center justify-between gap-3 text-sm text-ink-700">
                  <span>{label}</span>
                  <span className="flex items-center gap-1">
                    {k.split(' / ').map((part) => <Key key={part}>{part}</Key>)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="text-xs text-ink-400">Pulsa <Key>?</Key> en cualquier momento para ver esta lista.</p>
      </div>
    </Modal>
  );
}
