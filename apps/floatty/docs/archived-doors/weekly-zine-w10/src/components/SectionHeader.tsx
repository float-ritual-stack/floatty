import React from 'react';

interface SectionHeaderProps {
  title: string;
  accent: string;
}

export const SectionHeader: React.FC<SectionHeaderProps> = ({ title, accent }) => (
  <div className="mb-6">
    <h2 className="text-lg font-bold font-display uppercase tracking-tight text-zinc-200">
      {title}
    </h2>
    <div className="h-px mt-2" style={{ backgroundColor: accent, opacity: 0.4 }} />
  </div>
);
