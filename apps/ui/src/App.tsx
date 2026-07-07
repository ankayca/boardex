// Placeholder shell only — no product UI is built in T0.1 (see docs/BIBLE.md §8).
// It exists to prove the scaffold renders on the token background with Inter.
export default function App() {
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
