import React from 'react';
import type { Section, ShipItem } from '../data/w10';
import { SectionHeader } from './SectionHeader';
import { ShipItemCard } from './ShipItemCard';

interface ZineSectionProps {
  section: Section;
}

export const ZineSection: React.FC<ZineSectionProps> = ({ section }) => {
  const quotes = section.items.filter((i) => i.type === 'quote');
  const items = section.items.filter((i) => i.type !== 'quote');

  return (
    <section id={section.id} className="mb-16 scroll-mt-20">
      <SectionHeader title={section.title} accent={section.accent} />

      {items.map((item, i) => (
        <ShipItemCard key={i} item={item} accent={section.accent} />
      ))}

      {quotes.map((q, i) => (
        <div key={i} className="border-l-2 pl-4 py-3 my-4" style={{ borderColor: section.accent, opacity: 0.7 }}>
          <p className="text-sm text-zinc-300 italic leading-relaxed">
            &ldquo;{q.summary}&rdquo;
          </p>
          {q.title && (
            <div className="text-[10px] font-mono text-zinc-600 mt-1">
              &mdash; {q.title}
            </div>
          )}
        </div>
      ))}
    </section>
  );
};
