import React from 'react';
import type { ShipItem } from '../data/w10';
import { DoorButton } from './DoorButton';

interface ShipItemCardProps {
  item: ShipItem;
  accent: string;
}

const STATUS_COLORS: Record<string, string> = {
  merged: '#4ade80',
  shipped: '#4ade80',
  fixed: '#4ade80',
  open: '#fbbf24',
};

export const ShipItemCard: React.FC<ShipItemCardProps> = ({ item, accent }) => {
  const borderColor = item.highlight ? accent : '#262626';

  return (
    <div
      className="border-l-2 pl-4 py-2 mb-4"
      style={{ borderColor }}
    >
      <div className="flex items-start gap-2">
        <h3 className={`font-mono text-sm leading-snug ${item.highlight ? 'text-zinc-200' : 'text-zinc-300'}`}>
          {item.title}
        </h3>
        {item.status && (
          <span
            className="shrink-0 text-[10px] font-mono uppercase mt-0.5"
            style={{ color: STATUS_COLORS[item.status] || '#71717a' }}
          >
            {item.status}
          </span>
        )}
      </div>

      <p className="text-xs text-zinc-500 leading-relaxed mt-1">
        {item.summary}
      </p>

      {item.scope && (
        <div className="text-[10px] font-mono text-zinc-600 mt-1">
          {item.scope}
        </div>
      )}

      <div className="flex items-center gap-3 mt-2">
        {item.doors.map((door) => (
          <DoorButton key={door.label} door={door} />
        ))}
        {item.tags && item.tags.map((tag) => (
          <span key={tag} className="text-[10px] font-mono text-zinc-600">
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
};
