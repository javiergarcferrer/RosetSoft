import { useEffect, useState } from 'react';
import { db } from '../db/database.js';
import { ImageOff } from 'lucide-react';

/**
 * Renders an image stored in the IndexedDB `images` table by id.
 * Falls back to a neutral placeholder when missing.
 */
export default function ImageView({ id, alt = '', className = '', placeholderClassName = '' }) {
  const [url, setUrl] = useState(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let active = true;
    let local = null;
    if (!id) {
      setMissing(true);
      setUrl(null);
      return () => {};
    }
    setMissing(false);
    db.images.get(id).then((rec) => {
      if (!active) return;
      if (!rec || !rec.blob) {
        setMissing(true);
        setUrl(null);
        return;
      }
      local = URL.createObjectURL(rec.blob);
      setUrl(local);
    });
    return () => {
      active = false;
      if (local) URL.revokeObjectURL(local);
    };
  }, [id]);

  if (missing || !url) {
    return (
      <div
        className={`flex items-center justify-center bg-ink-100 text-ink-400 ${placeholderClassName || className}`}
      >
        <ImageOff size={18} />
      </div>
    );
  }
  return <img src={url} alt={alt} className={className} loading="lazy" />;
}
