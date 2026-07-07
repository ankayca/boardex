import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';

// Dev-only gallery route (BIBLE §8 T0.5): lazy so it never lands in the prod bundle,
// and the route itself is only registered in dev builds.
const DesignGalleryPage = lazy(() => import('./design/DesignGalleryPage'));

// Placeholder home — no product UI before Sprint 1 (see docs/BIBLE.md §8).
function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-app font-sans text-text-primary">
      <div className="text-center">
        <h1 className="text-page font-semibold">Boardex</h1>
        <p className="mt-2 text-body text-text-secondary">
          Scaffold ready. The product UI is built in later sprints.
        </p>
      </div>
    </main>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      {import.meta.env.DEV && (
        <Route
          path="/design"
          element={
            <Suspense fallback={null}>
              <DesignGalleryPage />
            </Suspense>
          }
        />
      )}
    </Routes>
  );
}
