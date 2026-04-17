import React from 'react';
import type { WeekData } from '../data/w10';
import { StatsBar } from './StatsBar';

interface ZineHeaderProps {
  data: WeekData;
}

export const ZineHeader: React.FC<ZineHeaderProps> = ({ data }) => (
  <header className="mb-12">
    <h1 className="text-3xl md:text-4xl font-black font-display uppercase tracking-tight text-zinc-200 leading-none mb-2">
      This Week in Float
    </h1>
    <div className="text-sm font-mono text-zinc-500 mb-6">
      {data.week} &middot; {data.dateRange}
    </div>
    <div className="h-px bg-zinc-800 mb-6" />
    <StatsBar stats={data.stats} />
  </header>
);
