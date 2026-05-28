import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Professional AR Viewer',
  description: 'Mobile WebXR AR viewer for a real-scale GLB model.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
