import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { db } from '../db/database.js';
import { publicImageUrl } from '../db/supabaseClient.js';
import { ImageOff } from 'lucide-react';

export interface ImageViewProps {
  id: string | null | undefined;
  alt?: string;
  className?: string;
  placeholderClassName?: string;
  style?: CSSProperties;
}

/**
 * Renders an image stored in Supabase Storage by its image-table id.
 * Falls back to a neutral placeholder when missing.
 */
export default function ImageView({ id, alt = '', className = '', placeholderClassName = '', style }: ImageViewProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let active = true;
    if (!id) {
      setMissing(true);
      setUrl(null);
      return () => {};
    }
    setMissing(false);
    db.images.get(id).then((rec: { storagePath?: string } | null | undefined) => {
      if (!active) return;
      const u = rec?.storagePath ? publicImageUrl(rec.storagePath) : null;
      if (!u) {
        setMissing(true);
        setUrl(null);
        return;
      }
      setUrl(u);
    }).catch(() => {
      if (active) { setMissing(true); setUrl(null); }
    });
    return () => { active = false; };
  }, [id]);

  if (missing || !url) {
    return (
      <div className={`flex items-center justify-center bg-ink-100 text-ink-400 ${placeholderClassName || className}`}>
        <ImageOff size={18} />
      </div>
    );
  }
  return <img src={url} alt={alt} className={className} style={style} loading="lazy" />;
}
