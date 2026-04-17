import React from 'react';
import type { Section } from '../data/w10';

interface ZineNavProps {
  sections: Section[];
  activeSection: string | null;
  week: string;
  onNavigate: (sectionId: string) => void;
}

export const ZineNav: React.FC<ZineNavProps> = ({
  sections,
  activeSection,
  week,
  onNavigate,
}) => (
  <nav
    className="fixed top-0 right-0 h-full w-48 bg-[#0a0a0a] border-l border-zinc-800 z-40 hidden lg:flex flex-col"
    role="navigation"
    aria-label="Zine sections"
  >
    <div className="p-4 border-b border-zinc-800">
      <div className="font-mono text-xs text-zinc-500">{week}</div>
    </div>

    <div className="flex-1 overflow-y-auto py-4">
      {sections.map((section) => {
        const isActive = activeSection === section.id;
        return (
          <button
            key={section.id}
            onClick={() => {
              document.getElementById(section.id)?.scrollIntoView({ behavior: 'smooth' });
              onNavigate(section.id);
            }}
            className={`block w-full text-left px-4 py-2 font-mono text-xs transition-colors ${
              isActive
                ? 'text-zinc-200 border-l-2'
                : 'text-zinc-600 hover:text-zinc-400 border-l-2 border-transparent'
            }`}
            style={isActive ? { borderColor: section.accent } : undefined}
            aria-current={isActive ? 'true' : undefined}
          >
            {section.title}
          </button>
        );
      })}
    </div>

    <div className="p-4 border-t border-zinc-800">
      <div className="font-mono text-[10px] text-zinc-700">
        float.dispatch
      </div>
    </div>
  </nav>
);
