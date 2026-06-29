import ContactModal from './ContactModal.jsx';

/**
 * Professional create/edit modal — a thin wrapper over the shared ContactModal
 * primitive (kept so the existing call sites keep their `professional` prop
 * name). Used by the Professionals list, ProfessionalDetail and the quote
 * builder's QuoteHeader.
 */
export default function ProfessionalModal({ professional, onClose, onAfterDelete, onSaved, profileId }) {
  return (
    <ContactModal
      kind="professional"
      record={professional}
      onClose={onClose}
      onAfterDelete={onAfterDelete}
      onSaved={onSaved}
      profileId={profileId}
    />
  );
}
