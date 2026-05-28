import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="home-shell">
      <section className="home-card">
        <p className="eyebrow">WebXR Room Viewer</p>

        <h1>Place the 3D model in your real space.</h1>

        <p>
          Open the camera, scan the floor, and place the model at a stable real-world position using WebXR AR.
        </p>

        <Link className="primary-link" href="/ar">
          Launch AR Viewer
        </Link>
      </section>
    </main>
  );
}