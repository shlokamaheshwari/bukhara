// The Companion widget — an illustrated character that sits at the corner
// of the play area, "draped over" the hand row's top edge like a dog on a
// windowsill. Krypto in light modes, Batmobile in dark modes.
//
// The image files are baked into public/ (WebP, ~250-290 KB each). Both
// are painted illustrations already showing the character on a stone
// ledge, so no compositing needed — the sprite IS the pose.

type Mode = 'light' | 'dark';

export function Companion({ mode }: { mode: Mode }) {
  const src = mode === 'dark' ? '/batmobile-parked.webp' : '/krypto-perched.webp';
  const alt = mode === 'dark'
    ? 'The Batmobile, parked on the ledge'
    : 'Krypto, resting on the ledge';
  return (
    <div className="companion" aria-hidden="true">
      <img className="companion-img" src={src} alt={alt} loading="lazy" />
    </div>
  );
}
