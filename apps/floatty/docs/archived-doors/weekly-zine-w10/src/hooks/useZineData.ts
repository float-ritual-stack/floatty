import { useState } from 'react';
import { W10_DATA, type WeekData } from '../data/w10';

export function useZineData() {
  const [data] = useState<WeekData>(W10_DATA);
  const [loading] = useState(false);
  const [error] = useState<string | null>(null);

  return { data, loading, error };
}
