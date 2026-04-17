import React from 'react';
import type { StatItem } from '../data/w10';

interface StatsBarProps {
  stats: StatItem[];
}

export const StatsBar: React.FC<StatsBarProps> = ({ stats }) => (
  <div className="font-mono text-sm text-zinc-400 mb-12 flex flex-wrap gap-x-1">
    {stats.map((stat, i) => (
      <React.Fragment key={stat.label}>
        <span>
          <span className="text-zinc-200">{stat.value}</span>{' '}
          <span className="uppercase text-xs">{stat.label}</span>
        </span>
        {i < stats.length - 1 && (
          <span className="text-zinc-700 mx-1">|</span>
        )}
      </React.Fragment>
    ))}
  </div>
);
