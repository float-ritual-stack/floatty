import { useState, useEffect, useCallback } from 'react';
import { useZineData } from './hooks/useZineData';
import { useZineRoute } from './hooks/useZineRoute';
import { ZineLayout } from './components/ZineLayout';
import { ZineHeader } from './components/ZineHeader';
import { ZineNav } from './components/ZineNav';
import { ZineSection } from './components/ZineSection';

export default function App() {
  const { data, loading, error } = useZineData();
  const route = useZineRoute();
  const [activeSection, setActiveSection] = useState<string | null>(route.section);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        });
      },
      { threshold: 0.2, rootMargin: '-20% 0px -50% 0px' },
    );

    document.querySelectorAll('section[id]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (route.section) {
      document.getElementById(route.section)?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [route.section]);

  const handleSectionNav = useCallback(
    (sectionId: string) => {
      setActiveSection(sectionId);
      route.navigate({ section: sectionId, week: route.week });
    },
    [route],
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <pre className="font-mono text-zinc-500 text-sm">loading...</pre>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <pre className="font-mono text-red-400 text-sm">ERR :: {error}</pre>
      </div>
    );
  }

  return (
    <>
      <ZineNav
        sections={data.sections}
        activeSection={activeSection}
        week={data.week}
        onNavigate={handleSectionNav}
      />

      <ZineLayout>
        <ZineHeader data={data} />

        {data.sections.map((section) => (
          <ZineSection key={section.id} section={section} />
        ))}

        <footer className="border-t border-zinc-800 pt-8 pb-4 text-center">
          <p className="font-mono text-[10px] text-zinc-700">
            float.dispatch &middot; y2026w10 &middot; shacks not cathedrals
          </p>
        </footer>
      </ZineLayout>
    </>
  );
}
