import React from 'react';

interface ZineLayoutProps {
  children: React.ReactNode;
}

export const ZineLayout: React.FC<ZineLayoutProps> = ({ children }) => (
  <div className="min-h-screen bg-[#0a0a0a] text-zinc-400 pb-24">
    <main className="lg:pr-48" role="main">
      <div className="max-w-3xl mx-auto px-6 py-12 md:py-20">{children}</div>
    </main>
  </div>
);
