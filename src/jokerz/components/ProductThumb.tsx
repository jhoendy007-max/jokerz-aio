import { useState } from 'react';
import { Package } from 'lucide-react';

/** Product photo with a neutral placeholder when missing or broken. */
export default function ProductThumb({ src, size = 48 }: { src?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const show = src && !broken;
  return (
    <div
      className="shrink-0 rounded-lg bg-white/95 border border-[#1f1f1f] overflow-hidden flex items-center justify-center"
      style={{ width: size, height: size, background: show ? '#fff' : '#0a0a0a' }}
    >
      {show ? (
        <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="w-full h-full object-contain" />
      ) : (
        <Package size={Math.round(size * 0.4)} className="text-[#444]" />
      )}
    </div>
  );
}
