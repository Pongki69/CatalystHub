import { useEffect, useRef, useState } from 'react';
import { Check, Image as ImageIcon, X } from 'lucide-react';
import { createPortal } from 'react-dom';

type Props = { source: string; kind: 'avatar' | 'cover'; onCancel: () => void; onApply: (image: string) => void };

export default function ImageCropDialog({ source, kind, onCancel, onApply }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [error, setError] = useState('');
  const aspect = kind === 'avatar' ? 1 : 3.2;

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const baseScale = imageRef.current && size.width && size.height
    ? Math.max(size.width / imageRef.current.naturalWidth, size.height / imageRef.current.naturalHeight)
    : 1;
  const width = imageRef.current ? imageRef.current.naturalWidth * baseScale * zoom : size.width;
  const height = imageRef.current ? imageRef.current.naturalHeight * baseScale * zoom : size.height;
  const position = (axis: 'x' | 'y', full: number, view: number) => Math.min(0, Math.max(view - full, offset[axis]));
  const left = position('x', width, size.width);
  const top = position('y', height, size.height);

  function apply() {
    const image = imageRef.current;
    if (!image || !size.width || !size.height) return;
    const scale = baseScale * zoom;
    const canvas = document.createElement('canvas');
    const outputWidth = kind === 'avatar' ? 640 : 1600;
    const outputHeight = Math.round(outputWidth / aspect);
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext('2d');
    if (!context) { setError('Your browser could not prepare this image.'); return; }
    const sourceX = -left / scale;
    const sourceY = -top / scale;
    const sourceWidth = size.width / scale;
    const sourceHeight = size.height / scale;
    context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
    let quality = 0.88;
    let result = canvas.toDataURL('image/jpeg', quality);
    const limit = (kind === 'avatar' ? 500 : 1024) * 1024;
    while (result.length * 0.75 > limit && quality > 0.48) { quality -= 0.08; result = canvas.toDataURL('image/jpeg', quality); }
    if (result.length * 0.75 > limit) { setError('This crop is too large to save. Choose a smaller source image.'); return; }
    onApply(result);
  }

  return createPortal(<div className="fixed inset-0 z-[150] grid min-h-dvh place-items-center overflow-y-auto bg-[#07130e]/70 p-4 backdrop-blur-[2px]" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="crop-title" className="my-auto w-full max-w-2xl overflow-hidden rounded-2xl border border-line bg-white shadow-2xl">
      <header className="flex items-start justify-between border-b border-line p-5 sm:p-6"><div><div className="flex items-center gap-2 text-[10px] font-extrabold tracking-[.15em] text-leaf"><ImageIcon size={14}/> PROFILE {kind === 'avatar' ? 'PHOTO' : 'COVER'}</div><h2 id="crop-title" className="mt-2 text-xl font-extrabold">Adjust your {kind === 'avatar' ? 'profile photo' : 'cover image'}</h2><p className="mt-1 text-xs text-muted">Drag to position, then zoom in or out. Preview the result before saving.</p></div><button type="button" aria-label="Close crop editor" className="rounded-lg p-2 text-muted hover:bg-canvas" onClick={onCancel}><X size={18}/></button></header>
      <div className="p-5 sm:p-6"><div ref={frame} className="relative mx-auto overflow-hidden rounded-xl bg-[#17231d]" style={{ width: '100%', maxWidth: kind === 'avatar' ? 420 : 620, aspectRatio: String(aspect), touchAction: 'none', cursor: 'grab' }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, left, top }; }} onPointerMove={event => { if (!drag.current) return; setOffset({ x: drag.current.left + event.clientX - drag.current.x, y: drag.current.top + event.clientY - drag.current.y }); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <img ref={imageRef} src={source} alt="Crop preview" draggable={false} onLoad={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }} className="pointer-events-none absolute max-w-none select-none" style={{ width, height, left, top }} />
        <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/30" />
      </div><div className="mx-auto mt-4 flex max-w-[620px] items-center gap-3"><span className="text-xs font-semibold text-muted">Zoom</span><input aria-label="Zoom crop" type="range" min="1" max="3" step="0.01" value={zoom} onChange={event => { setZoom(Number(event.target.value)); setOffset(current => ({ x: current.x, y: current.y })); }} className="w-full accent-[#167a57]"/><span className="w-10 text-right text-xs tabular-nums text-muted">{zoom.toFixed(1)}×</span></div>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      <div className="mt-5 flex items-center justify-between border-t border-line pt-4"><div className="text-[11px] text-muted">{kind === 'avatar' ? 'Square crop · JPG/PNG/WebP · up to 500 KB' : 'Wide cover crop · JPG/PNG/WebP · up to 1 MB'}</div><div className="flex gap-2"><button type="button" onClick={onCancel} className="btn btn-subtle text-sm">Cancel</button><button type="button" onClick={apply} className="btn btn-primary text-sm"><Check size={15}/>Use this crop</button></div></div></div>
    </section>
  </div>, document.body);
}
