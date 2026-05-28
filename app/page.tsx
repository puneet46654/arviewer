import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="home-shell">
      <section className="home-card">
        <p className="eyebrow">Professional WebXR AR</p>
        <h1>Open the camera and place the 3D model in your real room.</h1>
        <p>
          Use an Android phone with Chrome and an ARCore-supported device for the best WebXR AR experience.
        </p>
        <Link className="primary-link" href="/ar">
          Launch AR Viewer
        </Link>
      </section>
    </main>
  );
}
