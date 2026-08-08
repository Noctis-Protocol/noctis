/**
 * Footer — quiet, one line
 */

export function Footer() {
  return (
    <footer className="mt-auto border-t border-border/40 py-8">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 px-5 text-sm text-ink-400 sm:flex-row">
        <p className="text-center sm:text-left">
          Encrypted balances · Uniswap settlement ·{" "}
          <span className="text-ink-500">Powered by Zama</span>
        </p>
        <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          <a href="/about" className="transition-colors hover:text-ink-800">
            About
          </a>
          <a href="/docs#try-the-pilot" className="transition-colors hover:text-ink-800">
            Pilot
          </a>
          <a href="/docs" className="transition-colors hover:text-ink-800">
            Docs
          </a>
          <a
            href="https://github.com/Noctis-Protocol/noctis"
            className="transition-colors hover:text-ink-800"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
