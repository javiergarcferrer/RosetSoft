import { createContext, useContext, useEffect, useState } from 'react';

/**
 * Breadcrumb leaf context — lets a detail/editor page feed its live entity name
 * (a vendor, an expediente, an invoice's client) to the auto breadcrumb bar
 * rendered up in the Layout. The route model supplies the static trail; this
 * supplies the dynamic last crumb so it reads "Compras y gastos › Mueblería X"
 * instead of "… › Detalle".
 */
const Ctx = createContext(null);

export function BreadcrumbProvider({ children }) {
  const [leaf, setLeaf] = useState(null);
  return <Ctx.Provider value={{ leaf, setLeaf }}>{children}</Ctx.Provider>;
}

/** Read the current leaf (for the breadcrumb bar). Safe outside a provider. */
export function useBreadcrumbLeaf() {
  return useContext(Ctx)?.leaf ?? null;
}

/**
 * Set the breadcrumb leaf for the lifetime of a page. Pass the entity name once
 * it's loaded (null/undefined while loading is fine — the trail falls back to a
 * generic label). Clears automatically on unmount.
 */
export function useSetBreadcrumb(label) {
  const setLeaf = useContext(Ctx)?.setLeaf;
  useEffect(() => {
    setLeaf?.(label || null);
    return () => setLeaf?.(null);
  }, [setLeaf, label]);
}
