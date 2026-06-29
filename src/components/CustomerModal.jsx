import ContactModal from './ContactModal.jsx';

/**
 * Customer create/edit modal — a thin wrapper over the shared ContactModal
 * primitive (kept so the existing call sites keep their `customer` prop name).
 * Used by the Customers list, CustomerDetail, the quote builder's CustomerPicker
 * and QuoteHeader.
 */
export default function CustomerModal({ customer, onClose, onAfterDelete, onSaved, profileId }) {
  return (
    <ContactModal
      kind="customer"
      record={customer}
      onClose={onClose}
      onAfterDelete={onAfterDelete}
      onSaved={onSaved}
      profileId={profileId}
    />
  );
}
