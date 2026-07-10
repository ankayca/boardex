import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import Layout from './shell/Layout';
import HomePage from './pages/home/HomePage';
import NewRunPage from './pages/composer/NewRunPage';
import RunPage from './pages/composer/RunPage';
import BoardsPage from './pages/boards/BoardsPage';
import BoardProfilePage from './pages/boards/BoardProfilePage';

// Dev-only gallery route (BIBLE §8 T0.5). Gate the lazy construction itself, not just
// the route: in a prod build `import.meta.env.DEV` is statically false, so the dynamic
// import lives in dead code and Rollup emits no gallery chunk at all.
const DesignGalleryPage = import.meta.env.DEV
  ? lazy(() => import('./design/DesignGalleryPage'))
  : null;

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/runs/new" element={<NewRunPage />} />
        <Route path="/runs/:id" element={<RunPage />} />
        {/* Evidence Detail (§7.4) is a drawer over the run page, not its own screen:
            the same RunPage renders, with RunPage opening the drawer on this path. */}
        <Route path="/runs/:id/evidence" element={<RunPage />} />
        <Route path="/boards" element={<BoardsPage />} />
        {/* Ordered: /boards/new is the Board Profile Builder's new-profile state
            (§7.5), not a profile whose id happens to be "new". */}
        <Route path="/boards/new" element={<BoardProfilePage />} />
        <Route path="/boards/:id" element={<BoardProfilePage />} />
      </Route>
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
