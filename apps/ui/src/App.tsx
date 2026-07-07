import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';

// Dev-only gallery route (BIBLE §8 T0.5). Gate the lazy construction itself, not
// just the route: in a prod build `import.meta.env.DEV` is statically false, so the
// dynamic import lives in dead code and Rollup emits no gallery chunk at all.
const DesignGalleryPage = import.meta.env.DEV
  ? lazy(() => import('./design/DesignGalleryPage'))
  : null;

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
      {import.meta.env.DEV && DesignGalleryPage && (
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
