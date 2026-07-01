import type { Card, Suit } from '../game/types';

const SUIT_GLYPH: Record<Suit, string> = { H: '♥', D: '♦', C: '♣', S: '♠' };
const RANK_LABEL: Record<number, string> = {
  1: 'A', 11: 'J', 12: 'Q', 13: 'K',
};

export type CardSize = 'sm' | 'md' | 'lg';

export function CardFace({
  card,
  size = 'md',
  selected,
  onClick,
  disabled,
  badge,
  jokerBadge,
}: {
  card: Card;
  size?: CardSize;
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  badge?: string;
  jokerBadge?: string;
}) {
  const rank = RANK_LABEL[card.rank] ?? String(card.rank);
  const suit = SUIT_GLYPH[card.suit];
  const red = card.suit === 'H' || card.suit === 'D';
  const cls = [
    'pc',
    `pc-${size}`,
    red ? 'pc-red' : 'pc-black',
    selected ? 'pc-selected' : '',
    disabled ? 'pc-disabled' : '',
    onClick ? 'pc-clickable' : '',
  ].filter(Boolean).join(' ');
  return (
    <button className={cls} onClick={onClick} disabled={disabled} type="button">
      <span className="pc-corner pc-tl">
        <span className="pc-rank">{rank}</span>
        <span className="pc-suit">{suit}</span>
      </span>
      <span className="pc-center">{suit}</span>
      <span className="pc-corner pc-br">
        <span className="pc-rank">{rank}</span>
        <span className="pc-suit">{suit}</span>
      </span>
      {badge && <span className="pc-badge">{badge}</span>}
      {jokerBadge && <span className="pc-joker-badge">JOKER→{jokerBadge}</span>}
    </button>
  );
}

export function CardBack({ size = 'md' }: { size?: CardSize }) {
  return (
    <div className={`pc pc-${size} pc-back`} aria-hidden="true">
      <div className="pc-back-inner" />
    </div>
  );
}

export function StackedCards({
  count,
  size = 'md',
  label,
}: {
  count: number;
  size?: CardSize;
  label?: string;
}) {
  const visible = Math.min(count, 3);
  return (
    <div className="pc-stack">
      {Array.from({ length: visible }).map((_, i) => (
        <div key={i} className="pc-stack-item" style={{ transform: `translate(${i * 2}px, ${i * -2}px)` }}>
          <CardBack size={size} />
        </div>
      ))}
      {count === 0 && <div className={`pc pc-${size} pc-empty`}>empty</div>}
      {label && <div className="pc-stack-label">{label}: {count}</div>}
    </div>
  );
}
