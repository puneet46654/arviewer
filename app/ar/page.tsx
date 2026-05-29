'use client';

import dynamic from 'next/dynamic';

const ProfessionalARViewer = dynamic(
  () => import('@/components/ProfessionalARViewer'),
  {
    ssr: false,
    loading: () => (
      <div className="ar-loading-placeholder">
        Preparing AR viewer…
      </div>
    ),
  }
);

export default function ARPage() {
  return <ProfessionalARViewer modelUrl="/models/your-model.glb" />;
}
